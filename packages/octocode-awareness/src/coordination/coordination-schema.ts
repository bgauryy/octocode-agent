import { CoordinationContinuity } from './coordination-continuity.js';

export abstract class CoordinationSchema extends CoordinationContinuity {
  protected initializeSchema(): void {
    // Every coordination table carries `workspace_path` so a single global store
    // (~/.octocode/agent/agent.sqlite3) isolates repos by column rather than by
    // file. locks/work_presence fold it into their composite primary keys; the
    // rest scope through indexes + `WHERE workspace_path = ?` on every query.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        title TEXT,
        goal TEXT,
        name TEXT,
        objective TEXT,
        lead_agent_id TEXT,
        artifact TEXT,
        doc_dir TEXT,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'DONE', 'ABANDONED', 'DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
        source_kind TEXT,
        source_key TEXT,
        rfc_path TEXT,
        rfc_revision TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        file_path TEXT,
        paths_json TEXT NOT NULL DEFAULT '[]',
        reasoning TEXT,
        acceptance TEXT,
        acceptance_criteria TEXT,
        created_by TEXT,
        check_command TEXT,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'VERIFY', 'DONE', 'FAILED', 'CANCELLED')),
        priority INTEGER NOT NULL DEFAULT 0,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        source_step_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        done_at TEXT,
        completed_at TEXT,
        verified_at TEXT,
        verified_by TEXT,
        verification_message TEXT
      );

      CREATE TABLE IF NOT EXISTS locks (
        workspace_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(workspace_path, file_path)
      );

      CREATE TABLE IF NOT EXISTS work_presence (
        workspace_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(workspace_path, file_path, agent_id)
      );

      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cleared_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        label TEXT NOT NULL,
        text TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        agent_id TEXT,
        task_context TEXT,
        observation TEXT,
        importance INTEGER CHECK(importance BETWEEN 1 AND 10),
        state TEXT DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE', 'SUPERSEDED')),
        superseded_by TEXT,
        artifact TEXT,
        repo TEXT,
        ref TEXT,
        file_tree_fingerprint TEXT,
        novelty_score REAL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        decay_half_life_days REAL,
        failure_signature TEXT,
        valid_from TEXT,
        valid_to TEXT,
        expired_at TEXT,
        updated_at TEXT,
        scope_kind TEXT,
        source_digest TEXT,
        verified_at TEXT,
        secret_scan_status TEXT,
        embedding BLOB,
        embedding_model TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        name TEXT,
        role TEXT,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'IDLE', 'LEFT')),
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(workspace_path, agent_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT,
        topic TEXT,
        text TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_receipts (
        message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY(message_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS event_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        workspace_path TEXT NOT NULL,
        event_type TEXT NOT NULL,
        aggregate_kind TEXT,
        aggregate_id TEXT,
        aggregate_revision TEXT,
        actor_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        session_id TEXT,
        correlation_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS event_consumers (
        workspace_path TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_path, consumer_id)
      );

      CREATE TABLE IF NOT EXISTS event_acknowledgements (
        event_id TEXT NOT NULL REFERENCES event_outbox(event_id) ON DELETE CASCADE,
        consumer_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('accept', 'hold', 'refuse')),
        decided_at TEXT NOT NULL,
        PRIMARY KEY(event_id, consumer_id)
      );

      CREATE TABLE IF NOT EXISTS pending_interactions (
        interaction_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('question', 'authorization')),
        request_json TEXT NOT NULL,
        answer_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'answered', 'cancelled', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS authorization_receipts (
        receipt_id TEXT PRIMARY KEY,
        interaction_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS capability_receipts (
        receipt_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_plans_ws ON plans(workspace_path, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_path, status);
      CREATE INDEX IF NOT EXISTS idx_work_presence_file ON work_presence(workspace_path, file_path);
      CREATE INDEX IF NOT EXISTS idx_work_presence_expires ON work_presence(expires_at);
      CREATE INDEX IF NOT EXISTS idx_handoffs_open ON handoffs(workspace_path, cleared_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_label ON memories(workspace_path, label);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(workspace_path, created_at);
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(workspace_path, status, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(workspace_path, to_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(workspace_path, topic, created_at);
      CREATE INDEX IF NOT EXISTS idx_event_outbox_workspace_sequence ON event_outbox(workspace_path, sequence);
      CREATE INDEX IF NOT EXISTS idx_event_outbox_aggregate ON event_outbox(workspace_path, aggregate_kind, aggregate_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_interactions_session_status ON pending_interactions(workspace_path, session_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_authorization_plan_revision ON authorization_receipts(workspace_path, plan_id, revision, consumed_at);
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_unverified ON tasks(status, verified_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at)');
    // Partial unique indexes for idempotent materialization.
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_source ON plans(workspace_path, source_kind, source_key) WHERE source_kind IS NOT NULL AND source_key IS NOT NULL');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_step ON tasks(plan_id, source_step_key) WHERE source_step_key IS NOT NULL');
  }
}
