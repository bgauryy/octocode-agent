import type { AgentRecord,AgentStatus,LiteMessage,MemoryItem,PruneResult } from '@octocodeai/octocode-shared/entities';
import { generateAgentName } from './agent-naming.js';
import { bytesToEmbedding,cosineSimilarity,embeddingToBytes,isEmbeddingEnabled,runHostEmbedder } from './embed.js';
import { CoordinationState } from './coordination-state.js';
import { agentFromRow,AgentRow,cutoffIso,DEFAULT_SEMANTIC_MIN_SIMILARITY,id,memoryFromRow,MemoryRow,messageFromRow,MessageRow,now,parseMetadata,required,splitFiles,splitTags } from './coordination-shared.js';
import { containsSecretLikeText } from '../memory-hardening.js';

export interface VerifiedMemoryV1 {
  version: 1;
  memoryId: string;
  label: string;
  text: string;
  scope: 'project' | 'artifact';
  sourceDigest: string;
  verifiedAt: string;
  validUntil?: string;
  importance: number;
  explanation?: string;
}

export abstract class CoordinationMemoryAgents extends CoordinationState {
  storeVerifiedMemory(params: { label: string; text: string; scope?: 'project' | 'artifact'; sourceDigest: string; verifiedAt?: string; validUntil?: string; importance?: number; tags?: string | string[] | null }): VerifiedMemoryV1 {
    const label = required(params.label, 'label');
    const text = required(params.text, 'text');
    const sourceDigest = required(params.sourceDigest, 'sourceDigest');
    if (containsSecretLikeText(`${label}\n${text}`)) throw new Error('memory rejected: secret-like content must never enter durable memory');
    const verifiedAt = params.verifiedAt ?? now();
    if (!Number.isFinite(Date.parse(verifiedAt))) throw new Error('verifiedAt must be an ISO timestamp');
    if (params.validUntil && !Number.isFinite(Date.parse(params.validUntil))) throw new Error('validUntil must be an ISO timestamp');
    const importance = Math.min(Math.max(Math.trunc(params.importance ?? 5), 1), 10);
    const memoryId = id('mem');
    this.db.prepare(`INSERT INTO memories(
      memory_id, workspace_path, label, text, tags_json, agent_id, task_context, observation, importance,
      state, valid_from, valid_to, scope_kind, source_digest, verified_at, secret_scan_status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'awareness', ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, 'passed', ?)`)
      .run(memoryId, this.workspace, label, text, JSON.stringify(splitTags(params.tags)), label, text, importance, verifiedAt, params.validUntil ?? null, params.scope ?? 'project', sourceDigest, verifiedAt, verifiedAt);
    this.embedMemory(memoryId, `${label}\n${text}`);
    return { version: 1, memoryId, label, text, scope: params.scope ?? 'project', sourceDigest, verifiedAt, ...(params.validUntil ? { validUntil: params.validUntil } : {}), importance };
  }

  recallVerifiedMemory(params: { query?: string; label?: string; sourceDigest?: string; scope?: 'project' | 'artifact'; limit?: number; now?: string } = {}): VerifiedMemoryV1[] {
    const stamp = params.now ?? now();
    const clauses = ["workspace_path = ?", "state = 'ACTIVE'", 'verified_at IS NOT NULL', "secret_scan_status = 'passed'", '(valid_to IS NULL OR valid_to > ?)'];
    const values: Array<string | number> = [this.workspace, stamp];
    if (params.query?.trim()) { clauses.push('(text LIKE ? OR label LIKE ? OR tags_json LIKE ?)'); const like = `%${params.query.trim()}%`; values.push(like, like, like); }
    if (params.label?.trim()) { clauses.push('label = ?'); values.push(params.label.trim()); }
    if (params.sourceDigest?.trim()) { clauses.push('source_digest = ?'); values.push(params.sourceDigest.trim()); }
    if (params.scope) { clauses.push('scope_kind = ?'); values.push(params.scope); }
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY importance DESC, verified_at DESC LIMIT ?`).all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      version: 1,
      memoryId: String(row['memory_id']), label: String(row['label']), text: String(row['text']),
      scope: row['scope_kind'] === 'artifact' ? 'artifact' : 'project', sourceDigest: String(row['source_digest']),
      verifiedAt: String(row['verified_at']), ...(row['valid_to'] ? { validUntil: String(row['valid_to']) } : {}),
      importance: Number(row['importance'] ?? 5),
      explanation: `verified memory; scope=${String(row['scope_kind'] ?? 'project')}; source=${String(row['source_digest'])}`,
    }));
  }

  storeMemory(params: { label: string; text: string; tags?: string | string[] | null }): MemoryItem {
    const stamp = now();
    const memoryId = id('mem');
    const label = required(params.label, 'label');
    const text = required(params.text, 'text');
    this.db.prepare('INSERT INTO memories(memory_id, workspace_path, label, text, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(memoryId, this.workspace, label, text, JSON.stringify(splitTags(params.tags)), stamp);
    // Best-effort: embed on write when a host embedder is configured. Never blocks the store.
    this.embedMemory(memoryId, `${label}\n${text}`);
    return this.getMemory(memoryId);
  }

  /** Compute + persist an embedding for one memory; silently no-ops when disabled or on failure. */
  protected embedMemory(memoryId: string, text: string): boolean {
    if (!isEmbeddingEnabled()) return false;
    try {
      const { embedding, model } = runHostEmbedder(text);
      this.db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE memory_id = ?')
        .run(embeddingToBytes(embedding), model, memoryId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Backfill embeddings for memories missing them (or all when force). Returns
   * how many were (re)embedded. No-op with embedded:0 when no host embedder.
   */
  reindexMemories(params: { force?: boolean; limit?: number } = {}): { enabled: boolean; scanned: number; embedded: number } {
    if (!isEmbeddingEnabled()) return { enabled: false, scanned: 0, embedded: 0 };
    const limit = Math.min(Math.max(params.limit ?? 500, 1), 5000);
    const where = params.force ? ' WHERE workspace_path = ?' : ' WHERE workspace_path = ? AND embedding IS NULL';
    const rows = this.db.prepare(`SELECT memory_id, label, text FROM memories${where} ORDER BY created_at DESC LIMIT ?`)
      .all(this.workspace, limit) as Array<{ memory_id: string; label: string; text: string }>;
    let embedded = 0;
    for (const row of rows) if (this.embedMemory(row.memory_id, `${row.label}\n${row.text}`)) embedded++;
    return { enabled: true, scanned: rows.length, embedded };
  }

  forgetMemory(params: { memoryId: string }): { forgotten: boolean } {
    const result = this.db.prepare('DELETE FROM memories WHERE memory_id = ?').run(required(params.memoryId, 'memory-id'));
    return { forgotten: result.changes > 0 };
  }

  recallMemory(params: { query?: string | null; label?: string | null; limit?: number; semantic?: boolean; minSimilarity?: number } = {}): MemoryItem[] {
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const query = params.query?.trim();
    const label = params.label?.trim();
    const minSimilarity = Math.min(Math.max(params.minSimilarity ?? DEFAULT_SEMANTIC_MIN_SIMILARITY, 0), 1);
    // Semantic path: only when explicitly requested, a query exists, and a host
    // embedder is configured. Any miss falls through to the lexical LIKE search.
    if (params.semantic && query && isEmbeddingEnabled()) {
      const semantic = this.recallSemantic(query, label, limit, minSimilarity);
      if (semantic.length > 0) return semantic;
    }
    const clauses: string[] = ['workspace_path = ?'];
    const values: string[] = [this.workspace];
    if (query) {
      clauses.push('(text LIKE ? OR tags_json LIKE ? OR label LIKE ?)');
      const like = `%${query}%`;
      values.push(like, like, like);
    }
    if (label) {
      clauses.push('label = ?');
      values.push(label);
    }
    const where = ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM memories${where} ORDER BY created_at DESC LIMIT ?`).all(...values, limit);
    return (rows as unknown as MemoryRow[]).map(memoryFromRow);
  }

  /**
   * Cosine-rank embedded memories against the query embedding. Loads at most the
   * 2000 most-recent embedded rows to bound heap; returns [] on any failure so
   * the caller falls back to lexical recall.
   *
   * Candidates are filtered to the CURRENT embedder's model: a stored vector was
   * only ever comparable to a query vector from the same model, and after a model
   * swap the `embedding_model` column is the only thing keeping cosine ranking
   * honest (cross-model vectors of the same dimension otherwise score as if
   * comparable — pure noise). Rows below `minSimilarity` are dropped so a weak
   * semantic pool degrades to lexical recall instead of masking a better hit.
   */
  protected recallSemantic(query: string, label: string | undefined, limit: number, minSimilarity: number): MemoryItem[] {
    let queryVec: Float32Array;
    let queryModel: string;
    try {
      const embedded = runHostEmbedder(query);
      queryVec = embedded.embedding;
      queryModel = embedded.model;
    } catch {
      return [];
    }
    const clauses = ['workspace_path = ?', 'embedding IS NOT NULL', 'embedding_model = ?'];
    const values: string[] = [this.workspace, queryModel];
    if (label) { clauses.push('label = ?'); values.push(label); }
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 2000`,
    ).all(...values) as unknown as MemoryRow[];
    const scored: MemoryItem[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const sim = cosineSimilarity(queryVec, bytesToEmbedding(row.embedding));
        // sim > 0 keeps the original "positive similarity only" guard (also drops
        // dimension-mismatched vectors, which score 0); minSimilarity is an
        // optional floor on top of that.
        if (sim > 0 && sim >= minSimilarity) scored.push({ ...memoryFromRow(row), similarity: sim });
      } catch { /* corrupted BLOB — skip */ }
    }
    return scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, limit);
  }

  pruneMemories(params: { olderThanMs: number; label?: string | null; dryRun?: boolean }): PruneResult {
    const olderThan = cutoffIso(params.olderThanMs);
    const label = params.label?.trim();
    const clauses = ['workspace_path = ?', 'created_at < ?'];
    const values: string[] = [this.workspace, olderThan];
    if (label) {
      clauses.push('label = ?');
      values.push(label);
    }
    const where = clauses.join(' AND ');
    const matched = (this.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${where}`).get(...values) as { count: number }).count;
    const dryRun = params.dryRun !== false;
    if (!dryRun && matched > 0) this.db.prepare(`DELETE FROM memories WHERE ${where}`).run(...values);
    return { dryRun, matched, deleted: dryRun ? 0 : matched, olderThan };
  }

  joinAgent(params: { agentId: string; name?: string | null; role?: string | null; metadata?: string | Record<string, unknown> | null }): AgentRecord {
    const stamp = now();
    const agentId = required(params.agentId, 'agent-id');
    const existing = this.db.prepare('SELECT name, metadata_json FROM agents WHERE workspace_path = ? AND agent_id = ?').get(this.workspace, agentId) as { name: string | null; metadata_json: string } | undefined;
    const metadataJson = params.metadata === undefined && existing ? existing.metadata_json : JSON.stringify(parseMetadata(params.metadata));
    // No explicit name and no remembered one → default to a funny host-tagged
    // codename (clawde-squidJobs / cursea-crabBohr / octo-inkstein) so a shared
    // registry shows WHO is running WHERE. Re-joins keep their existing name
    // (null routes through the COALESCE below).
    const name = params.name?.trim() || (existing?.name ? null : generateAgentName());
    this.db.prepare(`INSERT INTO agents(agent_id, workspace_path, name, role, status, metadata_json, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
      ON CONFLICT(workspace_path, agent_id) DO UPDATE SET name = COALESCE(excluded.name, agents.name),
        role = COALESCE(excluded.role, agents.role), status = 'ACTIVE', metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at`).run(
          agentId,
          this.workspace,
          name,
          params.role?.trim() || null,
          metadataJson,
          stamp,
          stamp,
        );
    return this.getAgent(agentId);
  }

  touchAgent(params: { agentId: string; status?: AgentStatus }): AgentRecord {
    const agentId = required(params.agentId, 'agent-id');
    const status = params.status ?? 'ACTIVE';
    const existing = this.db.prepare('SELECT * FROM agents WHERE workspace_path = ? AND agent_id = ?').get(this.workspace, agentId) as unknown as AgentRow | undefined;
    if (!existing) {
      this.joinAgent({ agentId });
      if (status === 'ACTIVE') return this.getAgent(agentId);
    }
    this.db.prepare('UPDATE agents SET status = ?, last_seen_at = ? WHERE workspace_path = ? AND agent_id = ?')
      .run(status, now(), this.workspace, agentId);
    return this.getAgent(agentId);
  }

  leaveAgent(params: { agentId: string }): AgentRecord {
    return this.touchAgent({ agentId: params.agentId, status: 'LEFT' });
  }

  listAgents(params: { includeLeft?: boolean; staleAfterMs?: number } = {}): AgentRecord[] {
    const clauses: string[] = ['workspace_path = ?'];
    const values: string[] = [this.workspace];
    if (!params.includeLeft || params.staleAfterMs) clauses.push("status != 'LEFT'");
    if (params.staleAfterMs) {
      clauses.push('last_seen_at < ?');
      values.push(cutoffIso(params.staleAfterMs));
    }
    const where = ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM agents${where} ORDER BY last_seen_at DESC, agent_id ASC`).all(...values);
    return (rows as unknown as AgentRow[]).map(agentFromRow);
  }

  sendMessage(params: { fromAgentId: string; toAgentId?: string | null; topic?: string | null; text: string; files?: string | string[] | null }): LiteMessage {
    const stamp = now();
    const messageId = id('msg');
    const fromAgentId = required(params.fromAgentId, 'from-agent-id');
    this.touchAgent({ agentId: fromAgentId });
    const toAgentId = params.toAgentId?.trim() || null;
    const topic = params.topic?.trim() || null;
    const messageText = required(params.text, 'text');
    const files = splitFiles(params.files);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO messages(message_id, workspace_path, from_agent_id, to_agent_id, topic, text, files_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          messageId,
          this.workspace,
          fromAgentId,
          toAgentId,
          topic,
          messageText,
          JSON.stringify(files),
          stamp,
        );
      this.insertOutboxEvent({
        version: 1,
        eventId: `evt_${messageId}`,
        workspace: this.workspace,
        type: 'peer.message',
        actor: { kind: 'agent', id: fromAgentId },
        provenance: { source: 'peer', trust: 'attributed-data' },
        aggregate: { kind: 'message', id: messageId },
        createdAt: stamp,
        payload: { messageId, fromAgentId, toAgentId, topic, text: messageText, files },
      });
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }
    return this.getMessage(messageId);
  }

  listMessages(params: { agentId?: string | null; includeRead?: boolean; topic?: string | null; limit?: number } = {}): LiteMessage[] {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const agentId = params.agentId?.trim();
    const topic = params.topic?.trim();
    const clauses: string[] = ['m.workspace_path = ?'];
    const values: string[] = [this.workspace];
    let readAt = 'NULL AS read_at';
    if (agentId) {
      clauses.push('m.from_agent_id != ?');
      values.push(agentId);
      clauses.push('(m.to_agent_id IS NULL OR m.to_agent_id = ?)');
      values.push(agentId);
      readAt = '(SELECT r.read_at FROM message_receipts r WHERE r.message_id = m.message_id AND r.agent_id = ?) AS read_at';
      values.unshift(agentId);
      if (!params.includeRead) {
        clauses.push('NOT EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = m.message_id AND r.agent_id = ?)');
        values.push(agentId);
      }
    }
    if (topic) {
      clauses.push('m.topic = ?');
      values.push(topic);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT m.*, ${readAt} FROM messages m${where} ORDER BY m.created_at DESC LIMIT ?`).all(...values, limit);
    return (rows as unknown as MessageRow[]).map(messageFromRow);
  }

  markMessageRead(params: { messageId: string; agentId: string }): LiteMessage {
    const message = this.getMessage(required(params.messageId, 'message-id'));
    const agentId = required(params.agentId, 'agent-id');
    this.touchAgent({ agentId });
    this.db.prepare(`INSERT INTO message_receipts(message_id, agent_id, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id, agent_id) DO UPDATE SET read_at = excluded.read_at`).run(message.messageId, agentId, now());
    return this.listMessages({ agentId, includeRead: true, limit: 100 }).find((item) => item.messageId === message.messageId) ?? this.getMessage(message.messageId);
  }

  pruneMessages(params: { olderThanMs: number; readOnly?: boolean; dryRun?: boolean }): PruneResult {
    const olderThan = cutoffIso(params.olderThanMs);
    const clauses = ['workspace_path = ?', 'created_at < ?'];
    const values: string[] = [this.workspace, olderThan];
    if (params.readOnly) clauses.push('EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = messages.message_id)');
    const where = clauses.join(' AND ');
    const matched = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`).get(...values) as { count: number }).count;
    const dryRun = params.dryRun !== false;
    if (!dryRun && matched > 0) this.db.prepare(`DELETE FROM messages WHERE ${where}`).run(...values);
    return { dryRun, matched, deleted: dryRun ? 0 : matched, olderThan };
  }

}
