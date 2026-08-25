import{resolve as rn}from"node:path";var an=["BUG","FEATURE","SUGGESTION","GOTCHA","IMPROVEMENT","DECISION","ARCHITECTURE","SECURITY","PERFORMANCE","TEST","BUILD","DOCS","CONFIG","WORKFLOW","REFACTOR","API","RELEASE","INCIDENT","EXPERIENCE","OVERRIDE","OTHER"],es=new Set(an),Ji={failed:8,partial:6,worked:5};function I(){return new Date().toISOString().replace(/\.\d{3}Z$/,"Z")}function j(t){if(!t)return[];if(Array.isArray(t))return t.map(String).filter(Boolean);try{let e=JSON.parse(String(t));return Array.isArray(e)?e.map(String).filter(Boolean):[]}catch{return[]}}function Zi(t){return t.length===0?",":","+t.join(",")+","}function on(t=[],e=""){let n=[...t];e&&n.push(...e.split(","));let r=new Set,s=[];for(let i of n){let a=i.trim().toLowerCase().replace(/[^a-zA-Z0-9_.:-]+/g,"-").replace(/^-|-$/g,"");a&&!r.has(a)&&(s.push(a),r.add(a))}return s}function ge(t=[]){let e=new Set;return t.map(n=>(n??"").trim().slice(0,512)).filter(n=>n&&!e.has(n)&&e.add(n)).slice(0,20)}function me(t){if(t==null||String(t).trim()==="")return"OTHER";let e=String(t).trim().toUpperCase().replace(/[\s-]+/g,"_");if(es.has(e))return e;throw new Error(`invalid label "${String(t)}"; allowed: ${an.join(", ")}`)}var cn=["claim","handoff","question","reply","blocker","request","decision","fyi"],ts=new Set(cn);function ln(t){let e=String(t??"").trim().toLowerCase();if(ts.has(e))return e;throw new Error(`invalid signal kind "${String(t)}"; allowed: ${cn.join(", ")}`)}var sn=["worked","partial","failed"];function Qi(t){if(t==null||String(t).trim()==="")return"partial";let e=String(t).trim().toLowerCase();if(sn.includes(e))return e;throw new Error(`invalid outcome "${String(t)}"; allowed: ${sn.join("|")}`)}function un(t,e){if(!t)return null;let n=String(t);return e?rn(e,n):rn(n)}function R(t){if(t==null)return null;let e=String(t).trim().slice(0,256);return e.length>0?e:null}function Ge(t){return{memory_id:t.memory_id,agent_id:t.agent_id,task_context:t.task_context,observation:t.observation,importance:t.importance,state:t.state??"ACTIVE",label:t.label??"OTHER",superseded_by:t.superseded_by??null,tags:j(t.tags_json),references:[],workspace_path:t.workspace_path??null,artifact:t.artifact??null,repo:t.repo??null,ref:t.ref??null,novelty_score:t.novelty_score??null,failure_signature:t.failure_signature??null,access_count:t.access_count??0,last_accessed_at:t.last_accessed_at??null,decay_half_life_days:t.decay_half_life_days??null,valid_from:t.valid_from??null,valid_to:t.valid_to??null,expired_at:t.expired_at??null,file_tree_fingerprint:t.file_tree_fingerprint??null,created_at:t.created_at,updated_at:t.updated_at??null}}function Ye(t,e){let n=t.replace(/\s+/g," ").trim();return n.length<=e?n:n.slice(0,Math.max(0,e-3)).trimEnd()+"..."}function ea(t){let e={memory_id:t.memory_id,label:t.label,importance:t.importance,task_context:Ye(t.task_context??"",120),observation:Ye(t.observation??"",200)},n=t.tags??[];n.length>0&&(e.tags=n.slice(0,3)),n.length>3&&(e.tag_count=n.length,e.tag_omitted_count=n.length-3);let r=t.references??[];return r.length>0&&(e.references=r.slice(0,3)),r.length>3&&(e.reference_count=r.length,e.reference_omitted_count=r.length-3),typeof t.score=="number"&&Number.isFinite(t.score)&&(e.score=Math.round(t.score*1e4)/1e4),t.failure_signature&&(e.failure_signature=t.failure_signature),e}import{createHash as ms}from"node:crypto";import{mkdirSync as us}from"node:fs";import{join as In,resolve as It,dirname as _s}from"node:path";import{join as ra,resolve as sa}from"node:path";import{homedir as ns}from"node:os";import _n from"node:path";function rs(t=process.env){let e=t.OCTOCODE_HOME;return e&&e.trim()?_n.resolve(e.trim()):_n.join(ns(),".octocode")}function En(t=process.env){return t.OCTOCODE_AGENT_DIR??rs(t)}var ss=new Map([[44,6],[50,7],[51,3]]);function is(t){let e=/^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/.exec(t.trim());if(!e)return null;let n=Number(e[1]),r=Number(e[2]),s=Number(e[3]);return[n,r,s].every(Number.isSafeInteger)?[n,r,s]:null}function dn(t){let e=is(t);if(!e)return{sqliteVersion:t,safe:!1,reason:"the embedded SQLite version could not be parsed"};let[n,r,s]=e,i=n>3||n===3&&r>51,a=n===3?ss.get(r):void 0,o=i||a!==void 0&&s>=a;return{sqliteVersion:t,safe:o,reason:o?"the embedded SQLite includes the concurrent WAL reset fix":"concurrent WAL requires SQLite 3.44.6, 3.50.7, or 3.51.3 (or a newer fixed release)"}}function gt(t){return dn(t).safe?"WAL":"DELETE"}var mt=`
    CREATE TABLE IF NOT EXISTS hook_receipts (
      workspace_path TEXT NOT NULL,
      host           TEXT NOT NULL CHECK(host IN ('claude','codex','cursor')),
      event          TEXT NOT NULL,
      status         TEXT NOT NULL CHECK(status IN ('success','failure')),
      last_seen_at   TEXT NOT NULL,
      PRIMARY KEY(workspace_path, host, event)
    );
`,oe=`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL,
      workspace_path TEXT,
      artifact       TEXT,
      repo           TEXT,
      ref            TEXT,
      started_at     TEXT NOT NULL,
      ended_at       TEXT,
      summary        TEXT
    );

    CREATE TABLE IF NOT EXISTS memories (
      memory_id             TEXT PRIMARY KEY,
      agent_id              TEXT NOT NULL,
      task_context          TEXT NOT NULL,
      observation           TEXT NOT NULL,
      importance            INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 10),
      state                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE', 'SUPERSEDED')),
      label                 TEXT NOT NULL DEFAULT 'OTHER',
      superseded_by         TEXT,
      tags_json             TEXT NOT NULL DEFAULT '[]',
      workspace_path        TEXT,
      artifact              TEXT,
      repo                  TEXT,
      ref                   TEXT,
      file_tree_fingerprint TEXT,
      novelty_score         REAL,
      last_accessed_at      TEXT,
      access_count          INTEGER NOT NULL DEFAULT 0,
      decay_half_life_days  REAL,
      failure_signature     TEXT,
      valid_from            TEXT,
      valid_to              TEXT,
      expired_at            TEXT,
      embedding             BLOB,
      embedding_model       TEXT,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at            TEXT
    );

    CREATE TABLE IF NOT EXISTS plans (
      plan_id        TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      objective      TEXT NOT NULL,
      lead_agent_id  TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK(status IN ('DRAFT','ACTIVE','PAUSED','COMPLETED','CANCELLED')),
      workspace_path TEXT NOT NULL,
      artifact       TEXT,
      doc_dir        TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_members (
      plan_id    TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
      agent_id   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'CONTRIBUTOR' CHECK(role IN ('LEAD','CONTRIBUTOR')),
      joined_at  TEXT NOT NULL,
      PRIMARY KEY(plan_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS plan_docs (
      plan_id       TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      title         TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'SUPPORTING' CHECK(kind IN ('PRIMARY','SUPPORTING')),
      ordinal       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(plan_id, relative_path)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id      TEXT PRIMARY KEY,
      plan_id      TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      reasoning    TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'OPEN'
                   CHECK(status IN ('OPEN','IN_PROGRESS','BLOCKED','VERIFY','DONE','FAILED','CANCELLED')),
      priority     INTEGER NOT NULL DEFAULT 0,
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_paths (
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      path    TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(task_id, path)
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id            TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      created_by         TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      PRIMARY KEY(task_id, depends_on_task_id),
      CHECK(task_id <> depends_on_task_id)
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      run_id         TEXT PRIMARY KEY,
      task_id        TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
      origin         TEXT NOT NULL DEFAULT 'TASK' CHECK(origin IN ('TASK','WORK','HOOK')),
      agent_id       TEXT NOT NULL,
      session_id     TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      rationale      TEXT NOT NULL,
      test_plan      TEXT NOT NULL,
      context_ref    TEXT,
      status         TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK(status IN ('PENDING','ACTIVE','SUCCESS','FAILED')),
      workspace_path TEXT,
      artifact       TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS run_files (
      run_id         TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE CASCADE,
      file_path      TEXT NOT NULL,
      reason_override TEXT,
      source         TEXT NOT NULL CHECK(source IN ('EXPLICIT','HOOK')),
      started_at     TEXT NOT NULL,
      heartbeat_at   TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      ended_at       TEXT,
      PRIMARY KEY(run_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS task_claims (
      task_id      TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
      run_id       TEXT NOT NULL UNIQUE REFERENCES task_runs(run_id) ON DELETE CASCADE,
      agent_id     TEXT NOT NULL,
      claimed_at   TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      event_id   TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      run_id     TEXT REFERENCES task_runs(run_id) ON DELETE SET NULL,
      agent_id   TEXT NOT NULL,
      event_type TEXT NOT NULL
                 CHECK(event_type IN ('CREATED','DEPENDENCY_ADDED','CLAIMED','SUBMITTED','BLOCKED','RELEASED','CLAIM_EXPIRED','VERIFIED','VERIFICATION_FAILED')),
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS locks (
      lock_id     TEXT PRIMARY KEY,
      file_path   TEXT NOT NULL,
      run_id      TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE CASCADE,
      acquired_at TEXT NOT NULL,
      expires_at  TEXT,
      UNIQUE(file_path, run_id)
    );

    CREATE TABLE IF NOT EXISTS delivery_state (
      consumer_id TEXT NOT NULL,
      channel     TEXT NOT NULL,
      scope_key   TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY(consumer_id, channel, scope_key)
    );

    ${mt}

    CREATE TABLE IF NOT EXISTS run_log (
      event_id   TEXT PRIMARY KEY,
      run_id     TEXT,
      agent_id   TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES task_runs(run_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS refinements (
      refinement_id  TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      artifact       TEXT,
      repo           TEXT,
      ref            TEXT,
      files_json     TEXT NOT NULL DEFAULT '[]',
      reasoning      TEXT NOT NULL,
      remember       TEXT NOT NULL,
      quality        TEXT NOT NULL CHECK(quality IN ('good','bad','handoff','instructions')) DEFAULT 'good',
      state          TEXT NOT NULL CHECK(state IN ('open','ongoing','done')) DEFAULT 'open',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signals (
      signal_id      TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      artifact       TEXT,
      repo           TEXT,
      ref            TEXT,
      from_agent     TEXT NOT NULL,
      to_agent       TEXT,
      kind           TEXT NOT NULL,
      subject        TEXT NOT NULL,
      body           TEXT,
      files_json     TEXT NOT NULL DEFAULT '[]',
      refs_json      TEXT NOT NULL DEFAULT '[]',
      thread_id      TEXT NOT NULL,
      reply_to       TEXT,
      importance     INTEGER NOT NULL DEFAULT 5,
      status         TEXT NOT NULL DEFAULT 'open'
                     CHECK(status IN ('open','resolved')),
      resolved_at    TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_reads (
      signal_id TEXT NOT NULL,
      agent_id  TEXT NOT NULL,
      read_at   TEXT NOT NULL,
      PRIMARY KEY (signal_id, agent_id),
      FOREIGN KEY(signal_id) REFERENCES signals(signal_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memory_refs (
      memory_id TEXT    NOT NULL,
      reference TEXT    NOT NULL,
      kind      TEXT,
      ordinal   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (memory_id, reference),
      FOREIGN KEY(memory_id) REFERENCES memories(memory_id) ON DELETE CASCADE
    );

    -- ARCH-5: Agent identity registry \u2014 maps opaque agentIds to human-readable names.
    -- Separate from memories so the mapping persists even when memories are pruned.
    -- ON CONFLICT logic in agents.ts ensures a non-empty name is never overwritten by ''.
    CREATE TABLE IF NOT EXISTS agents (
      agent_id       TEXT PRIMARY KEY,
      agent_name     TEXT NOT NULL DEFAULT '',
      workspace_path TEXT,
      artifact       TEXT,
      context        TEXT,   -- 'pi' | 'cursor' | 'claude-code' | etc
      registered_at  TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edit_log (
      edit_id        TEXT PRIMARY KEY,
      session_id     TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      run_id         TEXT REFERENCES task_runs(run_id) ON DELETE SET NULL,
      agent_id       TEXT NOT NULL,
      file_path      TEXT NOT NULL,
      operation      TEXT NOT NULL CHECK(operation IN ('create','update','delete','move','rename')),
      old_file_path  TEXT,          -- populated for move/rename operations
      lines_added    INTEGER,
      lines_removed  INTEGER,
      content_hash   TEXT,          -- sha256 of file content after edit
      workspace_path TEXT,
      artifact       TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS harness_log (
      harness_id   TEXT PRIMARY KEY,
      session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      agent_id     TEXT NOT NULL,
      workspace_path TEXT,
      artifact     TEXT,
      event_type   TEXT NOT NULL CHECK(event_type IN ('mine','propose','validate','apply','capture','reflect')),
      payload_json TEXT,           -- JSON with event-specific data
      memory_id    TEXT REFERENCES memories(memory_id) ON DELETE SET NULL,
      run_id       TEXT REFERENCES task_runs(run_id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
`,ce=`
  CREATE INDEX IF NOT EXISTS idx_sessions_agent     ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
  CREATE INDEX IF NOT EXISTS idx_sessions_scope     ON sessions(workspace_path, artifact);

  CREATE INDEX IF NOT EXISTS idx_memories_importance      ON memories(importance);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at      ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_state           ON memories(state);
  CREATE INDEX IF NOT EXISTS idx_memories_label           ON memories(label);
  CREATE INDEX IF NOT EXISTS idx_memories_failure_sig     ON memories(failure_signature);
  CREATE INDEX IF NOT EXISTS idx_memories_workspace_path  ON memories(workspace_path);
  CREATE INDEX IF NOT EXISTS idx_memories_scope           ON memories(workspace_path, repo, ref);
  CREATE INDEX IF NOT EXISTS idx_memories_artifact_scope  ON memories(workspace_path, artifact);
  CREATE INDEX IF NOT EXISTS idx_memories_repo_ref        ON memories(repo, ref);
  CREATE INDEX IF NOT EXISTS idx_memories_valid           ON memories(valid_from, valid_to);
  CREATE INDEX IF NOT EXISTS idx_memories_embedding_model ON memories(embedding_model);

  CREATE INDEX IF NOT EXISTS idx_plans_scope          ON plans(workspace_path, artifact, status);
  CREATE INDEX IF NOT EXISTS idx_plans_lead           ON plans(lead_agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_plan_members_agent   ON plan_members(agent_id, plan_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_plan_status    ON tasks(plan_id, status, priority DESC, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_deps_dependency ON task_dependencies(depends_on_task_id);
  CREATE INDEX IF NOT EXISTS idx_task_claims_agent    ON task_claims(agent_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_task_claims_expiry   ON task_claims(expires_at);
  CREATE INDEX IF NOT EXISTS idx_task_runs_status     ON task_runs(status);
  CREATE INDEX IF NOT EXISTS idx_task_runs_agent      ON task_runs(agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_task_runs_task       ON task_runs(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_task_runs_scope      ON task_runs(workspace_path, artifact);
  CREATE INDEX IF NOT EXISTS idx_task_events_task     ON task_events(task_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_run_files_path_active ON run_files(file_path, ended_at, expires_at);
  CREATE INDEX IF NOT EXISTS idx_run_files_heartbeat   ON run_files(heartbeat_at);

  CREATE INDEX IF NOT EXISTS idx_locks_file_path   ON locks(file_path);
  CREATE INDEX IF NOT EXISTS idx_locks_acquired_at ON locks(acquired_at);
  CREATE INDEX IF NOT EXISTS idx_locks_expires_at  ON locks(expires_at);

  CREATE INDEX IF NOT EXISTS idx_delivery_state_delivered ON delivery_state(delivered_at);

  CREATE INDEX IF NOT EXISTS idx_refinements_state         ON refinements(state);
  CREATE INDEX IF NOT EXISTS idx_refinements_scope         ON refinements(workspace_path, artifact);
  CREATE INDEX IF NOT EXISTS idx_refinements_repo          ON refinements(repo);
  CREATE INDEX IF NOT EXISTS idx_refinements_state_updated ON refinements(state, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_signals_status         ON signals(status);
  CREATE INDEX IF NOT EXISTS idx_signals_to_agent       ON signals(to_agent);
  CREATE INDEX IF NOT EXISTS idx_signals_workspace_path ON signals(workspace_path);
  CREATE INDEX IF NOT EXISTS idx_signals_scope          ON signals(workspace_path, artifact);
  CREATE INDEX IF NOT EXISTS idx_signals_created_at     ON signals(created_at);
  CREATE INDEX IF NOT EXISTS idx_signals_thread         ON signals(thread_id);

  CREATE INDEX IF NOT EXISTS idx_memory_refs_ref  ON memory_refs(reference);
  CREATE INDEX IF NOT EXISTS idx_memory_refs_kind ON memory_refs(kind);

  CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_path);
  CREATE INDEX IF NOT EXISTS idx_agents_scope     ON agents(workspace_path, artifact);
  CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at DESC);

  CREATE INDEX IF NOT EXISTS idx_edit_log_session     ON edit_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_edit_log_run         ON edit_log(run_id);
  CREATE INDEX IF NOT EXISTS idx_edit_log_agent       ON edit_log(agent_id);
  CREATE INDEX IF NOT EXISTS idx_edit_log_file        ON edit_log(file_path);
  CREATE INDEX IF NOT EXISTS idx_edit_log_workspace   ON edit_log(workspace_path);
  CREATE INDEX IF NOT EXISTS idx_edit_log_scope       ON edit_log(workspace_path, artifact);
  CREATE INDEX IF NOT EXISTS idx_edit_log_created_at  ON edit_log(created_at);

  CREATE INDEX IF NOT EXISTS idx_harness_log_session    ON harness_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_harness_log_agent      ON harness_log(agent_id);
  CREATE INDEX IF NOT EXISTS idx_harness_log_scope      ON harness_log(workspace_path, artifact);
  CREATE INDEX IF NOT EXISTS idx_harness_log_event_type ON harness_log(event_type);
  CREATE INDEX IF NOT EXISTS idx_harness_log_memory     ON harness_log(memory_id);
  CREATE INDEX IF NOT EXISTS idx_harness_log_run        ON harness_log(run_id);
`,Te=`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(memory_id UNINDEXED, task_context, observation, tags)
`;function Y(t){return!!t.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts'").get()}function Ve(t){let e=j(t.tags_json),n=(t.label??"OTHER").toLowerCase();return[...e,n,...t.references??[]].filter(Boolean).join(" ")}function ye(t){t.exec("SAVEPOINT rebuild_fts");try{t.exec("DELETE FROM memories_fts");let e=t.prepare("SELECT memory_id, task_context, observation, tags_json, label FROM memories").all();if(e.length>0){let r=t.prepare(`SELECT r.memory_id, r.reference
         FROM memory_refs r
         JOIN memories m ON m.memory_id = r.memory_id
         ORDER BY r.memory_id, r.ordinal`).all(),s=new Map;for(let i of r){let a=s.get(i.memory_id)??[];a.push(i.reference),s.set(i.memory_id,a)}for(let i of e)i.references=s.get(i.memory_id)??[]}let n=t.prepare("INSERT INTO memories_fts(memory_id, task_context, observation, tags) VALUES (?, ?, ?, ?)");for(let r of e)n.run(r.memory_id,r.task_context,r.observation,Ve(r));t.exec("RELEASE SAVEPOINT rebuild_fts")}catch(e){try{t.exec("ROLLBACK TO SAVEPOINT rebuild_fts")}catch{}try{t.exec("RELEASE SAVEPOINT rebuild_fts")}catch{}throw e}}function pn(t){if(/^https?:\/\//.test(t))return"url";let e=t.match(/^([a-zA-Z][a-zA-Z0-9_.\-]*):/);return e?e[1].toLowerCase():"other"}function Tt(t,e,n){t.prepare("DELETE FROM memory_refs WHERE memory_id = ?").run(e);let r=t.prepare("INSERT OR REPLACE INTO memory_refs(memory_id, reference, kind, ordinal) VALUES (?, ?, ?, ?)");n.forEach((s,i)=>r.run(e,s,pn(s),i))}function we(t){let e=I();if(t.prepare("SELECT COUNT(*) AS c FROM locks WHERE expires_at IS NOT NULL AND expires_at <= ?").get(e).c===0)return{pruned_locks:0};t.exec("SAVEPOINT evict_expired_locks");try{let r=t.prepare("DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at <= ?").run(e);return t.exec("RELEASE SAVEPOINT evict_expired_locks"),{pruned_locks:r.changes}}catch(r){try{t.exec("ROLLBACK TO SAVEPOINT evict_expired_locks")}catch{}try{t.exec("RELEASE SAVEPOINT evict_expired_locks")}catch{}throw r}}function as(t){St(t)}function St(t,e){let n=e??Se(t);if(n==="canonical"){t.isTransaction||t.exec("PRAGMA foreign_keys = ON");return}if(n==="prior-hook-receipts"){os(t);return}if(n==="prior-lifecycle-constraints"){cs(t);return}if(t.isTransaction)throw new Error("cannot initialize canonical Awareness inside a caller-owned transaction");t.exec("PRAGMA foreign_keys = OFF");let r=!1;try{le(()=>t.exec("BEGIN IMMEDIATE")),r=!0,Se(t)==="fresh"&&ls(t),t.exec("COMMIT"),r=!1}catch(s){if(r)try{t.exec("ROLLBACK")}catch{}throw s}finally{t.exec("PRAGMA foreign_keys = ON")}}function os(t){if(t.isTransaction)throw new Error("cannot migrate canonical Awareness inside a caller-owned transaction");let e=!1;try{le(()=>t.exec("BEGIN IMMEDIATE")),e=!0;let n=Se(t);if(n==="prior-hook-receipts")t.exec(mt);else if(n!=="canonical")throw new Error(`refusing hook receipt migration from schema state ${n}`);he(t),Ne(t),ht(t),t.exec("COMMIT"),e=!1}catch(n){if(e)try{t.exec("ROLLBACK")}catch{}throw n}}function cs(t){if(t.isTransaction)throw new Error("cannot migrate canonical Awareness inside a caller-owned transaction");let e=!1;try{t.exec("PRAGMA foreign_keys = OFF"),le(()=>t.exec("BEGIN IMMEDIATE")),e=!0;let n=Se(t);if(n==="prior-lifecycle-constraints")t.exec(`
        ALTER TABLE task_events RENAME TO task_events_prior_lifecycle;
        CREATE TABLE task_events (
          event_id   TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          run_id     TEXT REFERENCES task_runs(run_id) ON DELETE SET NULL,
          agent_id   TEXT NOT NULL,
          event_type TEXT NOT NULL
                     CHECK(event_type IN ('CREATED','DEPENDENCY_ADDED','CLAIMED','SUBMITTED','BLOCKED','RELEASED','CLAIM_EXPIRED','VERIFIED','VERIFICATION_FAILED')),
          message    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO task_events(event_id, task_id, run_id, agent_id, event_type, message, created_at)
          SELECT event_id, task_id, run_id, agent_id, event_type, message, created_at
          FROM task_events_prior_lifecycle;
        DROP TABLE task_events_prior_lifecycle;

        ALTER TABLE signal_reads RENAME TO signal_reads_prior_lifecycle;
        ALTER TABLE signals RENAME TO signals_prior_lifecycle;
        CREATE TABLE signals (
          signal_id      TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          artifact       TEXT,
          repo           TEXT,
          ref            TEXT,
          from_agent     TEXT NOT NULL,
          to_agent       TEXT,
          kind           TEXT NOT NULL,
          subject        TEXT NOT NULL,
          body           TEXT,
          files_json     TEXT NOT NULL DEFAULT '[]',
          refs_json      TEXT NOT NULL DEFAULT '[]',
          thread_id      TEXT NOT NULL,
          reply_to       TEXT,
          importance     INTEGER NOT NULL DEFAULT 5,
          status         TEXT NOT NULL DEFAULT 'open'
                         CHECK(status IN ('open','resolved')),
          resolved_at    TEXT,
          created_at     TEXT NOT NULL
        );
        INSERT INTO signals(
          signal_id, workspace_path, artifact, repo, ref, from_agent, to_agent, kind, subject, body,
          files_json, refs_json, thread_id, reply_to, importance, status, resolved_at, created_at
        )
          SELECT signal_id, workspace_path, artifact, repo, ref, from_agent, to_agent, kind, subject, body,
            files_json, refs_json, thread_id, reply_to, importance, status, resolved_at, created_at
          FROM signals_prior_lifecycle;
        DROP TABLE signals_prior_lifecycle;

        CREATE TABLE signal_reads (
          signal_id TEXT NOT NULL,
          agent_id  TEXT NOT NULL,
          read_at   TEXT NOT NULL,
          PRIMARY KEY (signal_id, agent_id),
          FOREIGN KEY(signal_id) REFERENCES signals(signal_id) ON DELETE CASCADE
        );
        INSERT INTO signal_reads(signal_id, agent_id, read_at)
          SELECT signal_id, agent_id, read_at FROM signal_reads_prior_lifecycle;
        DROP TABLE signal_reads_prior_lifecycle;
      `),t.exec(ce),t.exec("PRAGMA foreign_keys = ON");else if(n!=="canonical")throw new Error(`refusing lifecycle-constraint migration from schema state ${n}`);he(t),Ne(t),t.exec("COMMIT"),e=!1}catch(n){if(e)try{t.exec("ROLLBACK")}catch{}throw n}finally{t.exec("PRAGMA foreign_keys = ON")}}function ls(t){t.exec(oe),t.exec(ce);try{t.exec(Te)}catch{}Y(t)&&ye(t),he(t),Ne(t),ht(t),t.exec(`PRAGMA application_id = ${De}`)}var Nt=process.listeners("warning");process.removeAllListeners("warning");var fn=t=>{if(!(t?.name==="ExperimentalWarning"&&String(t?.message).includes("SQLite")))for(let e of Nt)e.call(process,t)};process.on("warning",fn);var{DatabaseSync:te}=await import("node:sqlite");await new Promise(t=>setImmediate(t));process.removeAllListeners("warning");for(let t of Nt)process.on("warning",t);var gn=25,Ke=1e4,mn=new Int32Array(new SharedArrayBuffer(4));function Tn(t){if(!(t instanceof Error))return!1;let e=t;return e.errcode===5||/database is (?:locked|busy)/i.test(`${e.errstr??""} ${t.message}`)}function le(t){let e=Date.now()+Ke;for(;;)try{return t()}catch(n){if(!Tn(n)||Date.now()>=e)throw n;Atomics.wait(mn,0,0,gn)}}function qe(t){try{t.exec("PRAGMA wal_checkpoint(TRUNCATE)")}catch{}}var Es="awareness.sqlite3",ds="OCTOCODE_MEMORY_HOME",De=1329812529,ps,Sn=new Map;function Rn(){let t=process.env[ds];return t?.trim()?It(t.trim()):In(En(),"memory")}function fs(t){return t?It(t):In(Rn(),Es)}function Ln(t){us(_s(t),{recursive:!0});let e=new te(t);try{e.exec(`PRAGMA busy_timeout = ${Ke}`);let n=Se(e),r=e.prepare("SELECT sqlite_version() AS version").get(),s=gt(r.version);return le(()=>e.exec(`PRAGMA journal_mode = ${s}`)),e.exec("PRAGMA foreign_keys = ON"),St(e,n),ps=e,e}catch(n){throw e.close(),n}}function Ce(t){let e=t.prepare("PRAGMA application_id").get(),n=t.prepare(`
    SELECT name, type
    FROM sqlite_schema
    WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT GLOB 'memories_fts_*'
      AND name NOT GLOB 'memory_fts_*'
    ORDER BY name
  `).all();return{applicationId:e.application_id??0,relations:n}}function Se(t){let e=Ce(t);if(e.applicationId===De)return hn(t,e.relations)?"prior-hook-receipts":Nn(t,e.relations)?"prior-lifecycle-constraints":(he(t,e.relations),Ne(t),"canonical");if(e.applicationId!==0)throw new Error(`refusing foreign Awareness application_id ${e.applicationId}; expected ${De}. Another app owns this DB file \u2014 back it up, move it aside, then re-run to create a fresh Awareness store.`);if(e.relations.length===0)return"fresh";let n=e.relations.map(({name:r})=>r).join(", ");throw new Error(`refusing unrecognized or unrelated SQLite store; relations: ${n}. An unrelated DB owns this file \u2014 back it up, move it aside, then re-run to create a fresh Awareness store.`)}function ht(t){let n=t.prepare("PRAGMA integrity_check").all().filter(({integrity_check:s})=>s!=="ok");if(n.length>0)throw new Error(`canonical integrity_check failed: ${n.map(s=>s.integrity_check).join("; ")}`);let r=t.prepare("PRAGMA foreign_key_check").all();if(r.length>0)throw new Error(`canonical foreign_key_check failed with ${r.length} row(s)`)}function gs(t){let e=It(t),n=Sn.get(e);if(n)return n;let r=Ln(e);return Sn.set(e,r),r}function Rt(t,e){return t.prepare(`SELECT fingerprint FROM delivery_state
    WHERE consumer_id = ? AND channel = ? AND scope_key = ?`).get(e.consumerId,e.channel,e.scopeKey)?.fingerprint??null}function Lt(t,e){t.prepare(`INSERT INTO delivery_state
      (consumer_id, channel, scope_key, fingerprint, delivered_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(consumer_id, channel, scope_key) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      delivered_at = excluded.delivered_at`).run(e.consumerId,e.channel,e.scopeKey,e.fingerprint,e.deliveredAt??I())}function Ts(t,e){let n=t.prepare(`PRAGMA table_info(${e})`).all();return new Set(n.map(r=>r.name))}var ze;function At(){if(ze)return ze;let t=new te(":memory:");try{t.exec(oe);let e=t.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();return ze=new Map(e.map(({name:n})=>[n,t.prepare(`PRAGMA table_info(${n})`).all()])),ze}finally{t.close()}}function Ss(t){return t.replace(/--[^\n]*/g," ").replace(/["`\[\]]/g,"").replace(/\bIF\s+NOT\s+EXISTS\b/gi,"").replace(/\s+/g," ").replace(/\s*([(),])\s*/g,"$1").trim().toLowerCase()}function Ie(t){return t.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'view', 'index', 'trigger')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT GLOB 'memories_fts_*'
    ORDER BY type, name
  `).all().map(n=>({type:n.type,name:n.name,tableName:n.tbl_name,sql:Ss(n.sql??"")}))}function Re(t){return ms("sha256").update(JSON.stringify(t)).digest("hex")}var An=new Map,On=new Map,kn=new Map;function hs(){return oe.replace(`      event_type TEXT NOT NULL
                 CHECK(event_type IN ('CREATED','DEPENDENCY_ADDED','CLAIMED','SUBMITTED','BLOCKED','RELEASED','CLAIM_EXPIRED','VERIFIED','VERIFICATION_FAILED')),`,"      event_type TEXT NOT NULL,").replace(`      status         TEXT NOT NULL DEFAULT 'open'
                     CHECK(status IN ('open','resolved')),`,"      status         TEXT NOT NULL DEFAULT 'open',")}function Ns(t){let e=An.get(t);if(e)return e;let n=new te(":memory:");try{n.exec(oe),n.exec(ce),t&&n.exec(Te);let r=Re(Ie(n));return An.set(t,r),r}finally{n.close()}}function Is(t){let e=On.get(t);if(e)return e;let n=new te(":memory:");try{n.exec(oe),n.exec(ce),t&&n.exec(Te),n.exec("DROP TABLE hook_receipts");let r=Re(Ie(n));return On.set(t,r),r}finally{n.close()}}function hn(t,e){let n=e??Ce(t).relations,r=new Set([...At().keys()].filter(o=>o!=="hook_receipts")),s=n.filter(({name:o})=>o!=="memories_fts");if(s.some(({type:o})=>o!=="table")||s.length!==r.size||s.some(({name:o})=>!r.has(o)))return!1;let i=Ie(t),a=i.some(({type:o,name:c})=>o==="table"&&c==="memories_fts");return Re(i)===Is(a)}function Rs(t){let e=kn.get(t);if(e)return e;let n=new te(":memory:");try{n.exec(hs()),n.exec(ce),t&&n.exec(Te);let r=Re(Ie(n));return kn.set(t,r),r}finally{n.close()}}function Nn(t,e){let n=e??Ce(t).relations,r=new Set(At().keys()),s=n.filter(({name:o})=>o!=="memories_fts");if(s.some(({type:o})=>o!=="table")||s.length!==r.size||s.some(({name:o})=>!r.has(o)))return!1;let i=Ie(t),a=i.some(({type:o,name:c})=>o==="table"&&c==="memories_fts");return Re(i)===Rs(a)}function he(t,e){let n=e??Ce(t).relations,r=new Set(At().keys()),s=new Set(n.map(({name:c})=>c)),i=[...r].filter(c=>!s.has(c)),a=n.filter(({name:c,type:E})=>E!=="table"||!r.has(c)&&c!=="memories_fts");if(i.length===0&&a.length===0)return;let o=[i.length>0?`missing: ${i.join(", ")}`:null,a.length>0?`unexpected: ${a.map(({name:c})=>c).join(", ")}`:null].filter(c=>c!==null).join("; ");throw new Error(`canonical relation contract mismatch (${o})`)}function Ne(t){let e=Ie(t),n=e.some(({type:i,name:a})=>i==="table"&&a==="memories_fts"),r=Ns(n),s=Re(e);if(s!==r)throw new Error(`canonical schema fingerprint mismatch (expected ${r}, got ${s})`)}import{spawnSync as Ls}from"node:child_process";import{realpathSync as yn}from"node:fs";import{basename as kt,dirname as As,join as Os,resolve as xe}from"node:path";function Ot(t,e,n){try{let r=Ls(t,e,{cwd:n??process.cwd(),encoding:"utf8",timeout:5e3});return r.status===0?r.stdout.trim():null}catch{return null}}function ks(t){let e=Ot("git",["-C",t??".","rev-parse","--show-toplevel"]);if(!e)return{is_repo:!1};let n=Ot("git",["-C",e,"rev-parse","--abbrev-ref","HEAD"]),r=Ot("git",["-C",e,"remote","get-url","origin"]),s=r?(r.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)??[])[1]??kt(e):kt(e);return{is_repo:!0,root:e,repo:s,branch:n,remote:r}}function q(t){let e=xe(t),n=[];for(let r=0;r<4096;r+=1)try{return n.length?Os(yn(e),...n):yn(e)}catch{let s=As(e);if(s===e)return xe(t);n.unshift(kt(e)),e=s}return xe(t)}function F(t,e){let r={workspace_path:t.workspace_path?q(t.workspace_path):null,artifact:t.artifact??null,repo:t.repo??null,ref:t.ref??null},s=ks(r.workspace_path??e??process.cwd());return s.is_repo&&(s.root&&(r.workspace_path=q(s.root)),!r.repo&&s.repo&&(r.repo=s.repo),!r.ref&&s.branch&&(r.ref=s.branch)),r}function y(t,e){let n=t?xe(t):e?xe(e):null,r=F({workspace_path:n},n??process.cwd());return r.workspace_path?r.workspace_path:n}var wn={importance:.25,recency:.3,access:.15,lexical:.3},ys=30,ws=50,Dn=1,Cn=.01,wt=.35,Je=8,xn={DECISION:90,ARCHITECTURE:90,SECURITY:90,GOTCHA:90,OVERRIDE:90,EXPERIENCE:14},Dt=3,Ds=.45,Cs=12;function Me(t,e){if(t==null)return null;let n=String(t).trim();if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(n))throw new Error(`${e} must be a valid ISO 8601 timestamp`);let s=new Date(n);if(!n||Number.isNaN(s.getTime()))throw new Error(`${e} must be a valid ISO 8601 timestamp`);return s.toISOString().replace(/\.\d{3}Z$/,"Z")}var Mn=new Set(["the","and","for","with","from","into","not","this","that","its","what","when","about","before","after","are","was","has","had","can","did","use","used","using"]);function yt(t){let e=t.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g,"$1 $2").replace(/[:_-]/g," ").toLowerCase();return new Set((e.match(/[a-z0-9]{3,}/g)??[]).filter(n=>!Mn.has(n)))}function Ct(t,e){if(t.size===0||e.size===0)return 0;let n=0;for(let r of t)e.has(r)&&n++;return n/(t.size+e.size-n)}function Ze(t,e,n=3,r=null,s={}){let i=yt(e);return i.size===0?[]:Le(t,e,Cs,1,[],[],["ACTIVE"],s).filter(o=>o.memory_id!==r).map(o=>({memory_id:o.memory_id,similarity:Ct(i,yt(`${o.task_context} ${o.observation}`))})).filter(o=>o.similarity>=Ds).sort((o,c)=>c.similarity-o.similarity).slice(0,n)}function Qe(t,e,n=wn){let r=t.decay_half_life_days??ys,s=t.updated_at??t.created_at,i=0;if(s){let _=Math.max(0,(Date.now()-new Date(s).getTime())/864e5);i=Math.exp(-Math.LN2*_/Math.max(r,.01))}let a=(t.importance??0)/10,o=Math.min(Math.log1p(t.access_count??0)/Math.log1p(ws),1),c=Math.max(0,Math.min(1,e)),E=n.importance*a+n.recency*i+n.access*o+n.lexical*c;return{importance:a,recency:i,access:o,relevance:c,weights:n,final:E}}function xt(t,e,n=wn){return Qe(t,e,n).final}function Fn(t){let e=t.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g,"$1 $2").replace(/[:_-]/g," ").toLowerCase(),n=[...new Set((e.match(/[a-z0-9]{3,}/g)??[]).filter(r=>!Mn.has(r)))].slice(0,16);return n.length===0?null:n.join(" OR ")}function xs(t){return t.replace(/[\\%_]/g,"\\$&")}function Ms(t,e,n){let r=[...yt(t)].slice(0,16);if(r.length===0)return;let s=[];for(let i of r){let a=`%${xs(i)}%`;s.push(`(
      lower(m.task_context) LIKE ? ESCAPE '\\'
      OR lower(m.observation) LIKE ? ESCAPE '\\'
      OR lower(m.tags_json) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(m.label, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(m.workspace_path, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(m.artifact, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(m.repo, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(m.ref, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(m.failure_signature, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM memory_refs r
        WHERE r.memory_id = m.memory_id
          AND lower(r.reference) LIKE ? ESCAPE '\\'
      )
    )`),n.push(a,a,a,a,a,a,a,a,a,a)}e.push(`(${s.join(" OR ")})`)}function Mt(t,e,n,r,s){let i=[...n],a=[...r];Ms(e,i,a);let o=`
    SELECT m.*, 0 AS _bm25
    FROM memories m
    WHERE ${i.join(" AND ")}
    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT ?
  `;return t.prepare(o).all(...a,s)}function Pn(t,e,n={}){let r=R(n.artifact);if(n.allWorkspaces){r&&(t.push(n.strictScope?"m.artifact = ?":"(m.artifact IS NULL OR m.artifact = ?)"),e.push(r)),n.repo&&(t.push(n.strictScope?"m.repo = ?":"(m.repo IS NULL OR m.repo = ?)"),e.push(n.repo)),n.ref&&(t.push(n.strictScope?"m.ref = ?":"(m.ref IS NULL OR m.ref = ?)"),e.push(n.ref));return}let s=F({workspace_path:n.workspacePath??null,artifact:r,repo:n.repo??null,ref:n.ref??null},n.cwd??n.workspacePath??process.cwd());if(n.globalOnly){t.push("m.workspace_path IS NULL","m.artifact IS NULL","m.repo IS NULL","m.ref IS NULL");return}s.workspace_path&&(t.push(n.strictScope?"m.workspace_path = ?":"(m.workspace_path IS NULL OR m.workspace_path = ?)"),e.push(s.workspace_path)),s.artifact&&(t.push(n.strictScope?"m.artifact = ?":"(m.artifact IS NULL OR m.artifact = ?)"),e.push(s.artifact)),s.repo&&(t.push(n.strictScope?"m.repo = ?":"(m.repo IS NULL OR m.repo = ?)"),e.push(s.repo)),s.ref&&(t.push(n.strictScope?"m.ref = ?":"(m.ref IS NULL OR m.ref = ?)"),e.push(s.ref))}function Le(t,e,n,r,s,i,a,o={}){let c=e?Fn(e):null;if(e.trim()&&!c)return[];let E=[],_=["m.importance >= ?",`m.state IN (${a.map(()=>"?").join(",")})`];E.push(r,...a),i.length>0&&(_.push(`m.label IN (${i.map(()=>"?").join(",")})`),E.push(...i));for(let g of s)_.push("EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE value = ?)"),E.push(g);if(Pn(_,E,o),o.asOf)_.push("(m.valid_from IS NULL OR m.valid_from <= ?)"),_.push("(m.valid_to IS NULL OR m.valid_to > ?)"),E.push(o.asOf,o.asOf);else{let g=I();_.push(`(m.state <> 'ACTIVE' OR (
      (m.valid_from IS NULL OR m.valid_from <= ?)
      AND (m.valid_to IS NULL OR m.valid_to > ?)
    ))`),E.push(g,g)}let l=o.candidateMemoryIds?[...new Set(o.candidateMemoryIds)].filter(Boolean):null;if(l&&l.length===0)return[];let p=!1;if(l)if(l.length<=400)_.push(`m.memory_id IN (${l.map(()=>"?").join(",")})`),E.push(...l);else{t.exec("CREATE TEMP TABLE IF NOT EXISTS temp_memory_candidate_ids(memory_id TEXT PRIMARY KEY)"),t.exec("DELETE FROM temp_memory_candidate_ids");let g=t.prepare("INSERT OR IGNORE INTO temp_memory_candidate_ids(memory_id) VALUES (?)");for(let h of l)g.run(h);_.push("EXISTS (SELECT 1 FROM temp_memory_candidate_ids c WHERE c.memory_id = m.memory_id)"),p=!0}let d;try{if(c&&Y(t))try{let g=`
          SELECT m.*, ABS(bm25(memories_fts, 0, 10, 7, 2)) AS _bm25
          FROM memories m
          JOIN memories_fts ON memories_fts.memory_id = m.memory_id
          WHERE memories_fts MATCH ?
            AND ${_.join(" AND ")}
          ORDER BY _bm25 DESC
          LIMIT ?
        `;d=t.prepare(g).all(c,...E,n)}catch{d=Mt(t,e,_,E,n)}else d=Mt(t,e,_,E,n)}finally{if(p)try{t.exec("DELETE FROM temp_memory_candidate_ids")}catch{}}let u=d.reduce((g,h)=>Math.max(g,h._bm25??0),0);return d.map(g=>{let h=u>=Cn?(g._bm25??0)/(u+Dn):.5,f=Ge(g);return f.lexical=h,f.score=xt(f,h),f})}function et(t,e){if(e.length!==0)try{let n=[...new Set(e.map(a=>a.memory_id))],r=n.map(()=>"?").join(","),s=t.prepare(`SELECT memory_id, reference
       FROM memory_refs
       WHERE memory_id IN (${r})
       ORDER BY memory_id, ordinal`).all(...n),i=new Map;for(let a of s){let o=i.get(a.memory_id)??[];o.push(a.reference),i.set(a.memory_id,o)}for(let a of e)a.references=i.get(a.memory_id)??[]}catch(n){if(!(n instanceof Error&&n.message.includes("no such table")))throw n}}function Ft(t){try{return new RegExp(t)}catch(e){let n=e instanceof Error?e.message:String(e);throw new Error(`invalid regex ${JSON.stringify(t)}: ${n}`)}}function Fe(t,e){if(t===null)return new Set(e);let n=new Set;for(let r of t)e.has(r)&&n.add(r);return n}function Un(t,e){let n=ge(e);if(n.length===0)return new Set;let r=t.prepare(`SELECT memory_id
     FROM memory_refs
     WHERE reference IN (${n.map(()=>"?").join(",")})
     GROUP BY memory_id
     HAVING COUNT(DISTINCT reference) = ?`).all(...n,n.length);return new Set(r.map(s=>s.memory_id))}function bn(t,e){let n=new Set;for(let r of t){let s=String(r??"").trim();if(!s)continue;if(n.add(s),s.startsWith("file:")){let a=s.slice(5);a&&n.add(a);continue}n.add(`file:${s}`);let i=un(s,e??void 0);i&&(n.add(i),n.add(`file:${i}`))}return[...n]}function vn(t){let e=new Set;for(let n of t){let r=String(n??"").trim();r&&(r.startsWith("file:")&&(r=r.slice(5)),r=r.replace(/\\/g,"/").replace(/^\.\//,"").replace(/:\d+$/,""),r&&e.add(r))}return[...e]}function Pt(t,e){if(!t.startsWith("file:"))return!1;let n=t.slice(5).replace(/\\/g,"/").replace(/:\d+$/,"");return n?n===e||n.endsWith("/"+e)||e.endsWith("/"+n)||e===n:!1}function Wn(t,e){let n=[...new Set(e.map(i=>String(i??"").trim()).filter(Boolean))];if(n.length===0)return new Set;let r=t.prepare(`SELECT DISTINCT memory_id, reference
     FROM memory_refs
     WHERE kind = 'file' OR reference LIKE 'file:%'`).all(),s=new Set;for(let i of r)n.some(a=>Pt(i.reference,a))&&s.add(i.memory_id);return s}function Xn(t,e){let n=[...new Set(e.map(s=>String(s??"").trim().slice(0,512)).filter(Boolean))];if(n.length===0)return new Set;let r=t.prepare(`SELECT DISTINCT memory_id
     FROM memory_refs
     WHERE reference IN (${n.map(()=>"?").join(",")})`).all(...n);return new Set(r.map(s=>s.memory_id))}function Hn(t,e){if(e.length===0)return new Set;let n=t.prepare(`SELECT memory_id, reference
     FROM memory_refs
     WHERE kind = 'file' OR reference LIKE 'file:%'
     ORDER BY memory_id, ordinal`).all(),r=new Map;for(let i of n){let a=r.get(i.memory_id)??[];a.push(i.reference),r.set(i.memory_id,a)}let s=new Set;for(let[i,a]of r.entries())e.every(o=>a.some(c=>o.test(c)))&&s.add(i);return s}function $n(t,e){if(e.length===0)return new Set;let n=t.prepare(`SELECT m.*, group_concat(r.reference, char(31)) AS references_text
     FROM memories m
     LEFT JOIN memory_refs r ON r.memory_id = m.memory_id
     GROUP BY m.memory_id`).all(),r=new Set;for(let s of n){let i=[s.task_context,s.observation,...j(s.tags_json),...s.references_text?s.references_text.split(""):[],s.label,s.workspace_path,s.artifact,s.repo,s.ref,s.failure_signature].filter(Boolean).join(" ");e.every(a=>a.test(i))&&r.add(s.memory_id)}return r}import{randomUUID as Fs}from"node:crypto";function Ut(t,e){if(e.length===0)return;let n=I(),r=e.map(()=>"?").join(",");t.prepare(`
    UPDATE memories
    SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ?
    WHERE memory_id IN (${r})
  `).run(n,...e)}function Bn(t,e){let{agentId:n="agent",taskContext:r,observation:s,importance:i,label:a,tags:o=[],tagsCsv:c="",references:E=[],supersedes:_=[],failureSignature:l=null,validFrom:p,validTo:d,workspacePath:u,artifact:g,repo:h,ref:f,fileTreeFingerprint:T=null,cwd:S}=e,m=Number(i);if(!Number.isInteger(m)||m<1||m>10)throw new Error(`importance must be 1\u201310, got ${String(i)}`);let L=Me(p,"valid_from"),A=Me(d,"valid_to"),w="mem_"+Fs().replace(/-/g,""),v=on(o,c),X=ge(E),k=me(Array.isArray(a)?a[0]:a),D=I(),U=L??D;if(A!=null&&A<=U)throw new Error("valid_to must be after valid_from");let M=F({workspace_path:u??null,artifact:R(g),repo:h??null,ref:f??null},S??process.cwd()),B=[...new Set(_.filter(Boolean))],H=xn[k]??null,G=0,z=[],J=[],$=!t.isTransaction;$&&t.exec("BEGIN IMMEDIATE");try{if(B.length>0){let b=B.map(()=>"?").join(","),W=t.prepare(`
        SELECT memory_id, agent_id, state, workspace_path, artifact, repo, ref
        FROM memories WHERE memory_id IN (${b})
      `).all(...B),Z=new Map(W.map(x=>[String(x.memory_id),x]));for(let x of B){let V=Z.get(x);if(!V)throw new Error(`supersedes target not found: ${x}`);if(V.agent_id!==n)throw new Error(`supersedes target has a different owner: ${x}`);if(V.state!=="ACTIVE")throw new Error(`supersedes target is not ACTIVE: ${x}`);for(let ie of["workspace_path","artifact","repo","ref"])if((V[ie]??null)!==(M[ie]??null))throw new Error(`supersedes target has a different scope: ${x}`)}}let Q=e.preComputedSimilar??Ze(t,`${r} ${s}`,3,null,{workspacePath:M.workspace_path,artifact:M.artifact,repo:M.repo,ref:M.ref,cwd:S});if(G=Math.max(0,Math.min(1,1-(Q[0]?.similarity??0))),z=Q.map(b=>b.memory_id),t.prepare(`
      INSERT INTO memories (
        memory_id, agent_id, task_context, observation, importance,
        label, tags_json, workspace_path, artifact, repo, ref,
        file_tree_fingerprint, novelty_score, created_at, updated_at,
        last_accessed_at, access_count, failure_signature, valid_from, valid_to, decay_half_life_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(w,n,r,s,m,k,JSON.stringify(v),M.workspace_path,M.artifact,M.repo,M.ref,T,G,D,D,D,l??null,U,A,H),X.length>0)try{Tt(t,w,X)}catch(b){if(!(b instanceof Error&&b.message.includes("no such table")))throw b}Y(t)&&t.prepare("INSERT INTO memories_fts(memory_id, task_context, observation, tags) VALUES (?, ?, ?, ?)").run(w,r,s,Ve({tags_json:JSON.stringify(v),label:k,references:X}));for(let b of B){if(t.prepare(`
        UPDATE memories
        SET state = 'SUPERSEDED', superseded_by = ?, updated_at = ?,
            valid_to = COALESCE(valid_to, ?), expired_at = ?
        WHERE memory_id = ? AND state = 'ACTIVE'
      `).run(w,D,U,D,b).changes!==1)throw new Error(`supersedes target changed concurrently: ${b}`);J.push(b)}$&&t.exec("COMMIT")}catch(Q){if($)try{t.exec("ROLLBACK")}catch{}throw Q}return{memoryId:w,memory:{memory_id:w,agent_id:n,task_context:r,observation:s,importance:m,label:k,tags:v,references:X,workspace_path:M.workspace_path,artifact:M.artifact,repo:M.repo,ref:M.ref,failure_signature:l??null,novelty_score:G,state:"ACTIVE",created_at:D},superseded:J,noveltyScore:G,similarMemoryIds:z}}function Ps(t,e,n=!1){let r=Number(e.importance);if(!Number.isInteger(r)||r<1||r>10)throw new Error(`importance must be 1\u201310, got ${String(e.importance)}`);me(Array.isArray(e.label)?e.label[0]:e.label);let s=!t.isTransaction;s&&t.exec("BEGIN IMMEDIATE");try{let i=F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:e.repo??null,ref:e.ref??null},e.cwd??process.cwd()),a=e.supersedes??[],o=Ze(t,`${e.taskContext} ${e.observation}`,5,null,{workspacePath:i.workspace_path,artifact:i.artifact,repo:i.repo,ref:i.ref,cwd:e.cwd}),c=o.filter(_=>!a.includes(_.memory_id));if(c.length>0&&!n)return s&&t.exec("COMMIT"),{skipped:!0,similar:c};let E=Bn(t,{...e,preComputedSimilar:o});return s&&t.exec("COMMIT"),{skipped:!1,similar:o,result:E}}catch(i){if(s)try{t.exec("ROLLBACK")}catch{}throw i}}function bt(t,e={}){let{query:n="",limit:r=3,minImportance:s=1,label:i,tags:a=[],smart:o=!1,workspacePath:c,artifact:E,repo:_,ref:l,states:p,sort:d="smart",globalOnly:u=!1,strictScope:g=!1,allWorkspaces:h=!1,asOf:f,references:T=[],regex:S=[],fileRegex:m=[],files:L=[],explain:A=!1,candidateMemoryIds:w=[],recordAccess:v=!0,cwd:X}=e,k=w.length>0?2e3:50,D=Math.min(k,Math.max(1,Number(r)||3)),U=o===!0||o==="true",M=Math.max(1,Number(s)||1),B=!1,H=[],G=p??(f?["ACTIVE","SUPERSEDED"]:["ACTIVE"]),z=i?Array.isArray(i)?i.map(N=>me(N)):[me(i)]:[],J=M,$=[...z],Q=[...a],b=X??c??void 0,W=Me(f,"as_of"),Z=W?new Date(W):null;if(Z&&isNaN(Z.getTime()))throw new Error(`invalid --as-of value "${f}" \u2014 expected ISO 8601 date string (e.g. 2024-06-01T00:00:00Z)`);let x=w.length>0?new Set(w.filter(Boolean)):null,V=ge(T),ie=bn(L,b),pe=vn(L),ne=S.map(Ft),ae=m.map(Ft);if(V.length>0&&(x=Fe(x,Un(t,V))),pe.length>0){let N=Xn(t,ie),O=Wn(t,pe),P=new Set([...N,...O]);x=Fe(x,P)}ae.length>0&&(x=Fe(x,Hn(t,ae))),ne.length>0&&(x=Fe(x,$n(t,ne)));let Be={workspacePath:c??X??null,artifact:E,repo:_,ref:l,strictScope:g,globalOnly:u,allWorkspaces:h,cwd:X,asOf:W,candidateMemoryIds:x?[...x]:void 0},C=Le(t,n,D*Dt,M,a,z,G,{...Be});if(U&&C.length<D&&(z.length>0||a.length>0||M>1)){z.length>0&&!H.includes("label")&&H.push("label"),a.length>0&&!H.includes("tag")&&H.push("tag"),M>1&&!H.includes("min_importance")&&H.push("min_importance");let N=Le(t,n,D*Dt,1,[],[],G,Be),O=new Map(C.map(P=>[P.memory_id,P]));for(let P of N)O.set(P.memory_id,P);C=[...O.values()],B=!0,J=1,$=[],Q=[]}if(et(t,C),pe.length>0){let N=new Set(ie);C=C.filter(O=>O.references.some(P=>N.has(P))||O.references.some(P=>pe.some(ft=>Pt(P,ft))))}V.length>0&&(C=C.filter(N=>V.every(O=>N.references.includes(O)))),(ne.length>0||ae.length>0)&&(C=C.filter(N=>{if(ae.length>0){let O=(N.references??[]).filter(P=>P.startsWith("file:"));if(!ae.every(P=>O.some(ft=>P.test(ft))))return!1}if(ne.length>0){let O=[N.task_context,N.observation,...N.tags??[],...N.references??[],N.label,N.workspace_path,N.artifact,N.repo,N.ref,N.failure_signature].filter(Boolean).join(" ");if(!ne.every(P=>P.test(O)))return!1}return!0})),Z&&(C=C.filter(N=>{let O=N.valid_from?new Date(N.valid_from):null,P=N.valid_to?new Date(N.valid_to):null;return(!O||O<=Z)&&(!P||P>Z)}));let fe=(N,O)=>(N.memory_id??"").localeCompare(O.memory_id??"");if(d==="importance"?C.sort((N,O)=>O.importance-N.importance||(O.score??0)-(N.score??0)||fe(N,O)):d==="recent"?C.sort((N,O)=>(O.created_at??"").localeCompare(N.created_at??"")||fe(N,O)):d==="accessed"?C.sort((N,O)=>(O.last_accessed_at??O.created_at??"").localeCompare(N.last_accessed_at??N.created_at??"")||fe(N,O)):C.sort((N,O)=>(O.score??0)-(N.score??0)||fe(N,O)),C=C.slice(0,D),A)for(let N of C){let O=Qe(N,N.lexical??0);N.score_components=O,N.score=O.final}v&&Ut(t,C.map(N=>N.memory_id));let je=Y(t)?"lexical":"fallback",ee={count:C.length,memories:C,mode:je,sort:d,as_of:W,global_only:!!u,all_workspaces:!!h,states:G,...A?{applied_filters:{query:n,limit:D,min_importance:J,labels:$,tags:Q,references:V,files:L,file_regex:m,regex:S,workspace_path:c??X??null,artifact:E??null,repo:_??null,ref:l??null,strict_scope:!!g,global_only:!!u,all_workspaces:!!h,states:G,as_of:W,sort:d,smart:U}}:{},...B?{smart_expanded:!0,smart_dropped_filters:H}:{}};if(n.trim()){let N=C[0]?.lexical??0;C.length===0?(ee.judgment_required=!0,ee.judgment_reason=U?"no results after smart widening \u2014 absence of recall is not proof of absence; broaden the query terms or scope":"no results \u2014 absence of recall is not proof of absence; retry with --smart or broader terms"):je==="fallback"?(ee.judgment_required=!0,ee.judgment_reason="FTS unavailable \u2014 results are unranked substring matches; verify relevance before relying on them"):N<wt&&(ee.judgment_required=!0,ee.judgment_reason=`weak lexical match (top relevance ${N.toFixed(2)} < ${wt}) \u2014 treat results as leads, not answers`)}return ee}function jn(t,e,n){let r=[...new Set(e.memoryIds.map(String).filter(Boolean))];if(r.length===0)throw new Error("memory lifecycle requires at least one memoryId");let s=F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:e.repo??null,ref:e.ref??null},e.cwd??e.workspacePath??process.cwd()),i=[`memory_id IN (${r.map(()=>"?").join(",")})`,n],a=[...r];e.workspacePath&&s.workspace_path&&(i.push("workspace_path = ?"),a.push(s.workspace_path)),e.artifact&&s.artifact&&(i.push("artifact = ?"),a.push(s.artifact)),e.repo&&s.repo&&(i.push("repo = ?"),a.push(s.repo)),e.ref&&s.ref&&(i.push("ref = ?"),a.push(s.ref));let o=t.prepare(`SELECT memory_id FROM memories WHERE ${i.join(" AND ")}`).all(...a),c=new Set(o.map(E=>E.memory_id));return r.filter(E=>c.has(E))}function Us(t,e){let n=jn(t,e,"state = 'ACTIVE'");if(e.dryRun)return{archived:0,dry_run:!0,would_archive:n.length,memory_ids:n};if(n.length>0){let r=I();t.prepare(`UPDATE memories SET state = 'SUPERSEDED', expired_at = ?, updated_at = ?
       WHERE memory_id IN (${n.map(()=>"?").join(",")})`).run(r,r,...n)}return{archived:n.length,memory_ids:n}}function bs(t,e){let n=jn(t,e,"state = 'SUPERSEDED' AND superseded_by IS NULL AND expired_at IS NOT NULL");if(e.dryRun)return{restored:0,dry_run:!0,would_restore:n.length,memory_ids:n};if(n.length>0){let r=I();t.prepare(`UPDATE memories SET state = 'ACTIVE', expired_at = NULL, valid_to = NULL, updated_at = ?
       WHERE memory_id IN (${n.map(()=>"?").join(",")})`).run(r,...n)}return{restored:n.length,memory_ids:n}}function vs(t,e){let{memoryIds:n=[],tags:r=[],before:s,dryRun:i=!1}=e,{maxImportance:a}=e,o=F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:e.repo??null,ref:e.ref??null},e.cwd??e.workspacePath??process.cwd()),c=[],E=[],_=!1;n.length>0&&(c.push(`memory_id IN (${n.map(()=>"?").join(",")})`),E.push(...n));let l=[],p=[];if(r.length>0&&(l.push(`(${r.map(()=>"EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?)").join(" OR ")})`),p.push(...r)),s&&(l.push("created_at < ?"),p.push(s)),(l.length>0||a!=null)&&(a==null&&(a=Je-1,_=!0),l.push("importance <= ?"),p.push(a),c.push(`(${l.join(" AND ")})`),E.push(...p)),c.length===0)throw new Error("forgetMemory requires at least one filter: memoryIds, tags, before, or maxImportance");let d=[],u=[];e.workspacePath&&o.workspace_path&&(d.push("workspace_path = ?"),u.push(o.workspace_path)),e.artifact&&o.artifact&&(d.push("artifact = ?"),u.push(o.artifact)),e.repo&&o.repo&&(d.push("repo = ?"),u.push(o.repo)),e.ref&&o.ref&&(d.push("ref = ?"),u.push(o.ref));let g=c.join(" OR "),h=d.length>0?`(${g}) AND ${d.join(" AND ")}`:g,T=t.prepare(`SELECT memory_id FROM memories WHERE ${h}`).all(...E,...u).map(S=>S.memory_id);if(i)return{deleted:0,dry_run:!0,would_delete:T.length,memory_ids:T,..._?{salience_floor:Je}:{}};if(T.length>0){let S=T.map(()=>"?").join(",");t.exec("BEGIN IMMEDIATE");try{t.prepare(`DELETE FROM memories WHERE memory_id IN (${S})`).run(...T),Y(t)&&t.prepare(`DELETE FROM memories_fts WHERE memory_id IN (${S})`).run(...T);try{t.prepare(`DELETE FROM memory_refs WHERE memory_id IN (${S})`).run(...T)}catch{}t.exec("COMMIT")}catch(m){try{t.exec("ROLLBACK")}catch{}throw m}}return{deleted:T.length,memory_ids:T,..._?{salience_floor:Je}:{}}}function Yn(t){let e=t.indexOf("|surface:");return e>=0?t.slice(0,e):t}function Ws(t){let e=t.indexOf("|surface:");return e>=0?t.slice(e+9):null}function Gn(t){return new Set(t.split(/[|:]+/).map(e=>e.trim().toLowerCase()).filter(e=>e.length>2&&e!=="mechanism"&&e!=="cause"&&e!=="surface"))}function Xs(t,e={}){let{minCount:n=2,limit:r=20,cwd:s}=e,i=e.workspacePath?y(e.workspacePath,e.workspacePath):s?y(null,s):null,a=R(e.artifact),o=["failure_signature IS NOT NULL","state = 'ACTIVE'"],c=[];i&&(o.push("(workspace_path = ? OR workspace_path IS NULL)"),c.push(i)),a&&(o.push("(artifact = ? OR artifact IS NULL)"),c.push(a)),e.agentId&&(o.push("agent_id = ?"),c.push(e.agentId));let E=t.prepare(`
    SELECT failure_signature,
           count(*) AS freq,
           avg(importance) AS avg_imp,
           count(*) * avg(importance) AS score,
           group_concat(memory_id, ',') AS ids,
           group_concat(DISTINCT label) AS labels
    FROM memories
    WHERE ${o.join(" AND ")}
    GROUP BY failure_signature
    ORDER BY score DESC
  `).all(...c),_=new Map;for(let f of E){let T=Yn(f.failure_signature),S=Ws(f.failure_signature),m=_.get(T);if(m){m.total_freq+=f.freq,m.total_score+=f.score,m.importance_sum+=f.avg_imp*f.freq,m.ids.push(...f.ids.split(","));for(let L of f.labels.split(",").filter(Boolean))m.labels.add(L);S&&m.surfaces.add(S),f.score>m.raw_score&&(m.raw_sig=f.failure_signature,m.raw_score=f.score)}else _.set(T,{base_sig:T,raw_sig:f.failure_signature,total_freq:f.freq,total_score:f.score,importance_sum:f.avg_imp*f.freq,ids:f.ids.split(","),labels:new Set(f.labels.split(",").filter(Boolean)),surfaces:new Set(S?[S]:[]),raw_score:f.score})}let l=[..._.values()].filter(f=>f.total_freq>=n).sort((f,T)=>T.total_score-f.total_score),p=new Map,d=l.map(f=>f.raw_sig);if(d.length>0){let f=d.map(()=>"?").join(","),T=t.prepare(`SELECT failure_signature, observation, max(importance)
       FROM memories
       WHERE failure_signature IN (${f}) AND ${o.join(" AND ")}
       GROUP BY failure_signature`).all(...d,...c);for(let S of T)p.set(Yn(S.failure_signature),S.observation)}let u=[];for(let f of l){if(u.length>=r)break;let T=Gn(f.base_sig);u.some(m=>Ct(Gn(m.base_signature),T)>=.5)||u.push({failure_signature:f.raw_sig,base_signature:f.base_sig,surfaces:[...f.surfaces].sort(),count:f.total_freq,avg_importance:Math.round(f.importance_sum/f.total_freq*10)/10,score:Math.round(f.total_score*10)/10,memory_ids:[...new Set(f.ids)],representative:(p.get(f.base_sig)??"").slice(0,200),labels:[...f.labels].sort()})}let g=t.prepare(`SELECT count(DISTINCT failure_signature) AS sigs, count(*) AS mems
     FROM memories WHERE ${o.join(" AND ")}`).get(...c),h=u.length>0?"Next: choose one cluster, inspect its memory_ids, implement one scoped fix, verify it, then run octocode-awareness reflect record with the same --failure-signature and either --fix-repo or --fix-harness.":"No recurring failure cluster met the threshold. Record verified failures with octocode-awareness reflect record --failure-signature <signature>, then mine again after repetition.";return{ok:!0,clusters:u,total_signatures:g.sigs,total_memories:g.mems,next:h}}import{spawnSync as Hs}from"node:child_process";function $s(t=process.env){let e=t.OCTOCODE_EMBED_CMD;if(typeof e!="string")return null;let n=e.trim();return n.length>0?n:null}function ko(t,e={}){let n=e.command??$s(e.env);if(!n)throw new Error("OCTOCODE_EMBED_CMD is not set");let r=Hs(n,{input:t,encoding:"utf8",shell:!0,timeout:e.timeoutMs??15e3,env:e.env??process.env,maxBuffer:8*1024*1024});if(r.error)throw new Error(`OCTOCODE_EMBED_CMD failed to start: ${r.error.message}`);if(r.status!==0){let _=(r.stderr||r.stdout||"").trim().slice(0,400);throw new Error(`OCTOCODE_EMBED_CMD exited ${r.status}${_?`: ${_}`:""}`)}let s=(r.stdout||"").trim();if(!s)throw new Error("OCTOCODE_EMBED_CMD returned empty stdout");let i;try{i=JSON.parse(s)}catch{throw new Error("OCTOCODE_EMBED_CMD stdout is not JSON")}if(!i||typeof i!="object"||Array.isArray(i))throw new Error("OCTOCODE_EMBED_CMD JSON must be an object with embedding[]");let a=i,o=a.embedding;if(!Array.isArray(o)||o.length===0||!o.every(_=>typeof _=="number"&&Number.isFinite(_)))throw new Error("OCTOCODE_EMBED_CMD embedding must be a non-empty number[]");let c=a.model,E=typeof c=="string"&&c.trim()?c.trim():"host-embed";return{embedding:Float32Array.from(o),model:E}}function Vn(t,e){if(t.length===0||t.length!==e.length)return 0;let n=0,r=0,s=0;for(let a=0;a<t.length;a++)n+=t[a]*e[a],r+=t[a]*t[a],s+=e[a]*e[a];let i=Math.sqrt(r)*Math.sqrt(s);return i===0?0:n/i}function Bs(t,e,n,r){let s=Buffer.from(n.buffer,n.byteOffset,n.byteLength);t.prepare(`UPDATE memories SET embedding = ?, embedding_model = ?, updated_at = ?
     WHERE memory_id = ?`).run(s,r,I(),e)}function js(t,e,n=5,r=.75,s,i=["ACTIVE"]){let a=[...new Set(i.filter(Boolean))];if(a.length===0)return[];let o=[`state IN (${a.map(()=>"?").join(",")})`,"embedding IS NOT NULL"],c=[];c.push(...a),s&&(o.push("embedding_model = ?"),c.push(s));let E=t.prepare(`SELECT memory_id, embedding, embedding_model FROM memories
     WHERE ${o.join(" AND ")}
     ORDER BY COALESCE(last_accessed_at, created_at) DESC
     LIMIT 2000`).all(...c),_=[];for(let l of E)try{let p=new Float32Array(l.embedding.buffer,l.embedding.byteOffset,l.embedding.byteLength/4),d=Vn(e,p);d>=r&&_.push({memory_id:l.memory_id,similarity:d})}catch{}return _.sort((l,p)=>p.similarity-l.similarity).slice(0,n)}function Ys(t,e){let n=[...new Set(e.filter(Boolean))];if(n.length===0)return[];let r=n.map(()=>"?").join(", "),s=t.prepare(`SELECT * FROM memories WHERE memory_id IN (${r}) AND state = 'ACTIVE'`).all(...n),i=new Map(s.map(a=>[a.memory_id,Ge(a)]));return et(t,[...i.values()]),n.map(a=>i.get(a)).filter(a=>!!a)}import{randomUUID as Gs}from"node:crypto";var vt=`INSERT INTO sessions (session_id, agent_id, workspace_path, artifact, repo, ref, started_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`;var Kn=`SELECT session_id, agent_id, workspace_path, artifact, repo, ref, started_at, ended_at, summary
   FROM sessions WHERE session_id = ?`,qn=`SELECT session_id FROM sessions
   WHERE agent_id = ? AND workspace_path = ? AND (artifact = ? OR (artifact IS NULL AND ? IS NULL)) AND ended_at IS NULL
   LIMIT 1`,zn=`SELECT session_id, agent_id, workspace_path, artifact, repo, ref, started_at, ended_at, summary
   FROM sessions`,Jn="ORDER BY started_at DESC",Zn="agent_id = ?",Qn="workspace_path = ?",er="artifact = ?",tr="ended_at IS NULL";function Pe(t){return t?y(t,t):null}function Ue(t,e){let n=e.sessionId.trim();if(!n)throw new Error("session id is required");let r=Pe(e.workspacePath),s=R(e.artifact),i=nr(t,n);if(i){if(i.agent_id!==e.agentId)throw new Error(`session ${n} belongs to agent ${i.agent_id}`);if(i.workspace_path!==r)throw new Error(`session ${n} belongs to workspace ${i.workspace_path??"(none)"}`);if(i.artifact!==s)throw new Error(`session ${n} belongs to artifact ${i.artifact??"(none)"}`);if(i.ended_at!=null)throw new Error(`session ${n} has already ended`);return i}let a=I();return t.prepare(vt).run(n,e.agentId,r,s,null,null,a),nr(t,n)}function Vs(t,e){let n="sess_"+Gs(),r=I(),s=R(e.artifact),i=Pe(e.workspacePath);return t.prepare(vt).run(n,e.agentId,i,s,e.repo??null,e.ref??null,r),{session_id:n,agent_id:e.agentId,workspace_path:i,artifact:s,repo:e.repo??null,ref:e.ref??null,started_at:r,ended_at:null,summary:null}}function Go(t,e){let n=I(),r=["session_id = ?","agent_id = ?","ended_at IS NULL"],s=[e.sessionId,e.agentId];return e.workspacePath!==void 0&&(r.push("workspace_path IS ?"),s.push(Pe(e.workspacePath))),e.artifact!==void 0&&(r.push("artifact IS ?"),s.push(R(e.artifact))),t.prepare(`UPDATE sessions SET ended_at = ?, summary = ? WHERE ${r.join(" AND ")} RETURNING *`).get(n,e.summary??null,...s)??null}function nr(t,e){return t.prepare(Kn).get(e)??null}function Vo(t,e={}){let n=[],r=[];e.agentId!==void 0&&(n.push(Zn),r.push(e.agentId)),e.workspacePath!==void 0&&(n.push(Qn),r.push(Pe(e.workspacePath)));let s=R(e.artifact);s!==null&&(n.push(er),r.push(s)),e.active===!0&&n.push(tr);let i=n.length>0?`WHERE ${n.join(" AND ")}`:"",a=e.limit==null||!Number.isFinite(e.limit)?100:Math.floor(e.limit),o=Math.min(100,Math.max(1,a));return t.prepare(`${zn} ${i} ${Jn} LIMIT ?`).all(...r,o)}function Ko(t,e){let n=t.prepare(qn).get(e.agentId,Pe(e.workspacePath),R(e.artifact),R(e.artifact));return n?n.session_id:Vs(t,e).session_id}import{randomUUID as Wt}from"node:crypto";import{isAbsolute as Ks,resolve as tt}from"node:path";var qs=10*6e4,zs=60*6e4,Js=5;function Ae(t,e){let n=t?.trim()??"";if(!n)throw new Error(`${e} is required`);return n}function Xt(t){let e=t??process.cwd();return y(e,e)??tt(e)}function rt(t,e){if(t.length===0)throw new Error("at least one target file is required");let n=q(e?tt(e):process.cwd());return[...new Set(t.map(r=>{let s=Ae(r,"target file");return q(Ks(s)?tt(s):tt(n,s))}))]}function rr(t){let e=Math.min(Math.max(1,t??qs),zs);return new Date(Date.now()+e).toISOString().replace(/\.\d{3}Z$/,"Z")}function be(t,e){let n=t.prepare("SELECT * FROM task_runs WHERE run_id = ?").get(e);if(!n)throw new Error(`run not found: ${e}`);return n}function Ht(t,e){return t.prepare("SELECT * FROM run_files WHERE run_id = ? ORDER BY file_path").all(e)}function Zs(t,e,n){if(n.length===0)return[];let r=I();return t.prepare(`SELECT rf.run_id, tr.task_id, tr.origin, tr.agent_id, rf.file_path,
      tr.rationale, rf.heartbeat_at, rf.expires_at,
      EXISTS(SELECT 1 FROM locks l WHERE l.run_id = rf.run_id AND l.file_path = rf.file_path
        AND (l.expires_at IS NULL OR l.expires_at > ?)) AS exclusive
    FROM run_files rf
    JOIN task_runs tr ON tr.run_id = rf.run_id
    WHERE rf.run_id <> ?
      AND rf.file_path IN (${n.map(()=>"?").join(",")})
      AND rf.ended_at IS NULL AND rf.expires_at > ? AND tr.status = 'ACTIVE'
    ORDER BY rf.file_path, rf.heartbeat_at DESC, rf.run_id`).all(r,e,...n,r).map(i=>({...i,exclusive:!!i.exclusive}))}function nt(t,e,n){let r=Ht(t,e),s=n?new Set(n):null,i=s?r.filter(o=>s.has(o.file_path)):r,a=Zs(t,e,i.filter(o=>o.ended_at==null).map(o=>o.file_path));return{run:be(t,e),files:i,peers:a.slice(0,Js),peer_count:a.length}}function sr(t,e,n,r){if(n.length===0)return[];let s=I(),i=n.map(()=>"?").join(",");return r?t.prepare(`SELECT rf.run_id, tr.task_id, tr.origin, tr.agent_id, rf.file_path,
        tr.rationale, rf.heartbeat_at, rf.expires_at,
        EXISTS(SELECT 1 FROM locks l WHERE l.run_id = rf.run_id AND l.file_path = rf.file_path
          AND (l.expires_at IS NULL OR l.expires_at > ?)) AS exclusive,
        'ACTIVE_WORK' AS conflict_type
      FROM run_files rf JOIN task_runs tr ON tr.run_id = rf.run_id
      WHERE rf.file_path IN (${i}) AND rf.run_id <> ?
        AND rf.ended_at IS NULL AND rf.expires_at > ? AND tr.status = 'ACTIVE'
      ORDER BY rf.file_path, rf.heartbeat_at DESC`).all(s,...n,e,s):t.prepare(`SELECT l.run_id, tr.task_id, tr.origin, tr.agent_id, l.file_path,
      tr.rationale, rf.heartbeat_at, COALESCE(l.expires_at, rf.expires_at) AS expires_at,
      1 AS exclusive, 'EXCLUSIVE_LOCK' AS conflict_type
    FROM locks l
    JOIN task_runs tr ON tr.run_id = l.run_id
    LEFT JOIN run_files rf ON rf.run_id = l.run_id AND rf.file_path = l.file_path
    WHERE l.file_path IN (${i}) AND l.run_id <> ? AND tr.status = 'ACTIVE'
      AND (l.expires_at IS NULL OR l.expires_at > ?)
    ORDER BY l.file_path, l.acquired_at DESC`).all(...n,e,s)}function ir(t,e){let n=Ae(e.agentId,"agent id"),r=I(),s=rr(e.ttlMs),i=e.origin??"WORK",a=e.source??(i==="HOOK"?"HOOK":"EXPLICIT"),o=e.workspacePath??process.cwd(),c=Xt(e.workspacePath),E=R(e.artifact);if(e.runId!=null&&e.runId.trim()==="")throw new Error("run_id must be non-empty when provided");let _=e.runId??null;_||(Ae(e.rationale,"rationale"),Ae(e.testPlan,"test plan")),t.exec("BEGIN IMMEDIATE");try{_??=`run_${Wt().replace(/-/g,"")}`;let l=t.prepare("SELECT * FROM task_runs WHERE run_id = ?").get(_);if(l){if(l.agent_id!==n)throw new Error(`run ${_} belongs to ${l.agent_id}`);if(l.status!=="ACTIVE")throw new Error(`run ${_} is not ACTIVE`);let g=Xt(l.workspace_path);if(e.workspacePath!=null&&c!==g)throw new Error(`workspace ${c} does not match run workspace ${g}`);let h=R(l.artifact);if(e.artifact!=null&&E!==h)throw new Error(`artifact ${E??"(none)"} does not match run artifact ${h??"(none)"}`);if(c=g,E=h,o=g,e.sessionId!=null){if(e.sessionId!==l.session_id)throw new Error(`run ${_} belongs to session ${l.session_id??"(none)"}`);Ue(t,{sessionId:e.sessionId,agentId:n,workspacePath:g,artifact:h})}}else{if(e.runId)throw new Error(`run not found: ${e.runId}`);e.sessionId&&Ue(t,{sessionId:e.sessionId,agentId:n,workspacePath:c,artifact:E}),t.prepare(`INSERT INTO task_runs
        (run_id, task_id, origin, agent_id, session_id, rationale, test_plan, context_ref,
         status, workspace_path, artifact, created_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`).run(_,i,n,e.sessionId??null,Ae(e.rationale,"rationale"),Ae(e.testPlan,"test plan"),e.contextRef??null,c,E,r,r),l=be(t,_)}let p=rt(e.targetFiles,o),d=sr(t,_,p,e.exclusive===!0);if(d.length>0)return t.exec("ROLLBACK"),{ok:!1,conflict:!0,conflicts:d};let u=t.prepare(`INSERT INTO run_files
      (run_id, file_path, reason_override, source, started_at, heartbeat_at, expires_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(run_id, file_path) DO UPDATE SET
        reason_override = COALESCE(excluded.reason_override, run_files.reason_override),
        source = excluded.source,
        started_at = CASE WHEN run_files.ended_at IS NULL THEN run_files.started_at ELSE excluded.started_at END,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        ended_at = NULL`);for(let g of p)u.run(_,g,e.reasonOverride?.trim()||null,a,r,r,s),e.exclusive&&t.prepare(`INSERT INTO locks(lock_id, file_path, run_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(file_path, run_id) DO UPDATE SET expires_at = excluded.expires_at`).run(`lock_${Wt().replace(/-/g,"")}`,g,_,r,s);return t.prepare("UPDATE task_runs SET updated_at = ? WHERE run_id = ?").run(r,_),t.exec("COMMIT"),{ok:!0,...nt(t,_,p)}}catch(l){try{t.exec("ROLLBACK")}catch{}throw l}}function Qs(t,e,n={}){let r=be(t,e.runId);if(r.agent_id!==e.agentId)throw new Error(`run ${e.runId} belongs to ${r.agent_id}`);if(r.status!=="ACTIVE")throw new Error(`run ${e.runId} is not ACTIVE`);let s=I(),i=rr(e.ttlMs);t.exec("BEGIN IMMEDIATE");try{let a=be(t,e.runId);if(a.agent_id!==e.agentId)throw new Error(`run ${e.runId} belongs to ${a.agent_id}`);if(a.status!=="ACTIVE")throw new Error(`run ${e.runId} is not ACTIVE`);let o=t.prepare("SELECT file_path FROM locks WHERE run_id = ?").all(e.runId),c=new Set(o.map(p=>p.file_path)),E=n.exclusiveOnly?[...c]:e.targetFiles?.length?rt(e.targetFiles,a.workspace_path):Ht(t,e.runId).filter(p=>p.ended_at==null).map(p=>p.file_path);if(E.length===0){if(t.exec("COMMIT"),n.exclusiveOnly)return{result:nt(t,e.runId,[]),locksRenewed:0,expiresAt:null};throw new Error("run has no active file presence")}if(t.prepare(`SELECT file_path FROM run_files
      WHERE run_id = ? AND ended_at IS NULL AND file_path IN (${E.map(()=>"?").join(",")})`).all(e.runId,...E).length!==E.length)throw new Error("one or more active file presences were not found for this run");t.prepare("DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at <= ?").run(s);for(let p of E){let d=sr(t,e.runId,[p],c.has(p));if(d.length>0)throw new Error(`work lease conflict on ${p}: held by ${d.map(u=>u.agent_id).join(", ")}`)}let l=t.prepare(`UPDATE run_files SET heartbeat_at = ?, expires_at = ?
      WHERE run_id = ? AND file_path = ? AND ended_at IS NULL`);for(let p of E){if(l.run(s,i,e.runId,p).changes===0)throw new Error(`active file presence not found: ${p}`);c.has(p)&&t.prepare(`INSERT INTO locks(lock_id, file_path, run_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(file_path, run_id) DO UPDATE SET expires_at = excluded.expires_at`).run(`lock_${Wt().replace(/-/g,"")}`,p,e.runId,s,i)}return t.prepare("UPDATE task_runs SET updated_at = ? WHERE run_id = ?").run(s,e.runId),t.exec("COMMIT"),{result:nt(t,e.runId,E),locksRenewed:E.filter(p=>c.has(p)).length,expiresAt:i}}catch(a){try{t.exec("ROLLBACK")}catch{}throw a}}function tc(t,e){return Qs(t,e).result}function nc(t,e){let n=be(t,e.runId);if(n.agent_id!==e.agentId)throw new Error(`run ${e.runId} belongs to ${n.agent_id}`);if(n.origin==="TASK")throw new Error("TASK work must end through task submit or task release");let r=e.targetFiles?.length?rt(e.targetFiles,n.workspace_path):Ht(t,e.runId).filter(i=>i.ended_at==null).map(i=>i.file_path),s=I();t.exec("BEGIN IMMEDIATE");try{if(r.length>0){if(t.prepare(`UPDATE run_files SET heartbeat_at = ?, expires_at = ?, ended_at = ?
        WHERE run_id = ? AND file_path IN (${r.map(()=>"?").join(",")}) AND ended_at IS NULL`).run(s,s,s,e.runId,...r).changes!==r.length)throw new Error("one or more active file presences were not found for this run");t.prepare(`DELETE FROM locks WHERE run_id = ?
        AND file_path IN (${r.map(()=>"?").join(",")})`).run(e.runId,...r)}t.prepare(`SELECT 1 FROM run_files
      WHERE run_id = ? AND ended_at IS NULL AND expires_at > ? LIMIT 1`).get(e.runId,s)||t.prepare(`UPDATE task_runs SET status = 'PENDING', updated_at = ?
        WHERE run_id = ? AND status = 'ACTIVE' AND origin IN ('WORK','HOOK')`).run(s,e.runId),t.exec("COMMIT")}catch(i){try{t.exec("ROLLBACK")}catch{}throw i}return nt(t,e.runId,r)}function ei(t,e={}){let n=I(),r=["1 = 1"],s=[n];e.activeOnly!==!1&&(r.push("rf.ended_at IS NULL","rf.expires_at > ?","tr.status = 'ACTIVE'"),s.push(n)),e.workspacePath&&(r.push("tr.workspace_path = ?"),s.push(Xt(e.workspacePath)));let i=R(e.artifact);i&&(r.push("(tr.artifact = ? OR tr.artifact IS NULL)"),s.push(i)),e.agentId&&(r.push("tr.agent_id = ?"),s.push(e.agentId)),e.runId&&(r.push("tr.run_id = ?"),s.push(e.runId)),e.filePath&&(r.push("rf.file_path = ?"),s.push(rt([e.filePath],e.workspacePath)[0]));let a=e.limit==null?null:Math.max(1,Math.floor(e.limit)),o=a==null?"":"LIMIT ?";a!=null&&s.push(a);let c=t.prepare(`SELECT rf.*, tr.task_id, tr.origin, tr.agent_id, tr.session_id,
      tr.rationale, tr.test_plan, tr.status, tr.workspace_path, tr.artifact,
      EXISTS(SELECT 1 FROM locks l WHERE l.run_id = rf.run_id AND l.file_path = rf.file_path
        AND (l.expires_at IS NULL OR l.expires_at > ?)) AS exclusive,
      COUNT(*) OVER() AS result_total
    FROM run_files rf JOIN task_runs tr ON tr.run_id = rf.run_id
    WHERE ${r.join(" AND ")}
    ORDER BY rf.file_path, rf.heartbeat_at DESC, rf.run_id ${o}`).all(...s),E=c[0]?.result_total??0,_=c.map(({result_total:l,...p})=>({...p,exclusive:!!p.exclusive}));return{count:_.length,total_count:E,omitted_count:Math.max(0,E-_.length),files:_}}function rc(t,e){return ei(t,{...e,filePath:e.filePath})}import{isAbsolute as ti,resolve as st}from"node:path";var ar=10*6e4,uc=new Set(["PENDING","ACTIVE","SUCCESS","FAILED"]);function ni(t){return Math.min(Math.max(1,t??ar),ar)}function or(t){let e=t??process.cwd();return y(e,e)??st(e)}function ri(t){return t?st(t):process.cwd()}function _c(t=[],e){let n=ri(e);return t.map(r=>q(ti(r)?st(r):st(n,r)))}function it(t){return{path:t.filePath,agent:t.agentId,state:t.state??"locked",reason:t.reason,run_id:t.runId,expires_at:t.expiresAt}}function si(t,e={}){we(t);let n=I(),r=["ai.status = 'ACTIVE'","(fl.expires_at IS NULL OR fl.expires_at > ?)"],s=[n];e.workspacePath&&(r.push("ai.workspace_path = ?"),s.push(or(e.workspacePath)));let i=R(e.artifact);return i&&(r.push("(ai.artifact = ? OR ai.artifact IS NULL)"),s.push(i)),e.agentId&&(r.push("ai.agent_id = ?"),s.push(e.agentId)),e.sessionId&&(r.push("ai.session_id = ?"),s.push(e.sessionId)),e.runId&&(r.push("fl.run_id = ?"),s.push(e.runId)),t.prepare(`SELECT fl.run_id, fl.file_path, ai.agent_id, ai.rationale AS reason, fl.expires_at
       FROM locks fl
       JOIN task_runs ai ON ai.run_id = fl.run_id
      WHERE ${r.join(" AND ")}
      ORDER BY fl.acquired_at DESC`).all(...s).map(o=>it({filePath:o.file_path,agentId:o.agent_id,runId:o.run_id,reason:o.reason,expiresAt:o.expires_at}))}function Ec(t,e){let n=e.agentId??"agent",r=ir(t,{agentId:n,sessionId:e.sessionId,workspacePath:e.workspacePath,artifact:e.artifact,runId:e.runId,rationale:e.rationale??"agent write operation",testPlan:e.testPlan??"post-edit verification",contextRef:e.contextRef,targetFiles:e.targetFiles??[],origin:"WORK",source:"EXPLICIT",ttlMs:ni(e.ttlMs),exclusive:!0});if(!r.ok)return{ok:!1,conflict:!0,conflicts:r.conflicts.map(i=>it({filePath:i.file_path,agentId:i.agent_id,runId:i.run_id,reason:i.rationale,expiresAt:i.expires_at,state:"conflict"}))};let s=si(t,{runId:r.run.run_id});return{ok:!0,run:{run_id:r.run.run_id,task_id:r.run.task_id,origin:r.run.origin,agent_id:r.run.agent_id,session_id:r.run.session_id,workspace_path:r.run.workspace_path??or(e.workspacePath),artifact:r.run.artifact,context_ref:r.run.context_ref,target_files:r.files.filter(i=>i.ended_at==null).map(i=>i.file_path),locks:s,status:r.run.status,created_at:r.run.created_at}}}import{randomUUID as ii}from"node:crypto";import{isAbsolute as cr,relative as ai,resolve as at,sep as lr}from"node:path";var $t=30*6e4,Bt=60*6e4;function re(t,e){let n=t.trim();if(!n)throw new Error(`${e} is required`);return n}function ur(t,e){if(e.length===0)throw new Error("at least one task path is required");let n=at(t),r=e.map(s=>{let i=re(s,"task path"),a=cr(i)?at(i):at(n,i),o=ai(n,a);if(!o||o===".."||o.startsWith(`..${lr}`)||cr(o))throw new Error(`task path must be workspace-relative and below the workspace: ${s}`);return o.split(lr).join("/")});return[...new Set(r)]}function se(t,e,n,r,s,i,a=I()){t.prepare(`INSERT INTO task_events(event_id, task_id, run_id, agent_id, event_type, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`tevt_${ii().replace(/-/g,"")}`,e,n,r,s,i,a)}function K(t,e=I()){let n=t.prepare("SELECT task_id, run_id, agent_id FROM task_claims WHERE expires_at <= ?").all(e);if(n.length!==0){t.exec("SAVEPOINT evict_expired_task_claims");try{for(let r of n)t.prepare("DELETE FROM locks WHERE run_id = ?").run(r.run_id),t.prepare(`UPDATE run_files SET heartbeat_at = ?, expires_at = ?, ended_at = ?
        WHERE run_id = ? AND ended_at IS NULL`).run(e,e,e,r.run_id),t.prepare("UPDATE task_runs SET status = 'FAILED', updated_at = ? WHERE run_id = ? AND status = 'ACTIVE'").run(e,r.run_id),t.prepare("UPDATE tasks SET status = 'OPEN', updated_at = ? WHERE task_id = ? AND status = 'IN_PROGRESS'").run(e,r.task_id),t.prepare("DELETE FROM task_claims WHERE task_id = ?").run(r.task_id),se(t,r.task_id,r.run_id,r.agent_id,"CLAIM_EXPIRED","claim lease expired",e);t.exec("RELEASE SAVEPOINT evict_expired_task_claims")}catch(r){try{t.exec("ROLLBACK TO SAVEPOINT evict_expired_task_claims")}catch{}try{t.exec("RELEASE SAVEPOINT evict_expired_task_claims")}catch{}throw r}}}function ot(t,e){let n=String(e.task_id),r=t.prepare("SELECT path FROM task_paths WHERE task_id = ? ORDER BY ordinal, path").all(n).map(a=>String(a.path)),s=t.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at, depends_on_task_id").all(n).map(a=>String(a.depends_on_task_id)),i=t.prepare("SELECT * FROM task_claims WHERE task_id = ?").get(n);return{...e,paths:r,dependencies:s,claim:i??null}}function ue(t,e){K(t);let n=t.prepare("SELECT * FROM tasks WHERE task_id = ?").get(e);return n?ot(t,n):null}function oi(t,e){K(t);let n=y(e.workspacePath,e.workspacePath)??at(e.workspacePath),r=["c.agent_id = ?","p.workspace_path = ?","c.expires_at > ?"],s=[e.agentId,n,I()];e.artifact&&(r.push("(p.artifact = ? OR p.artifact IS NULL)"),s.push(e.artifact));let i=t.prepare(`SELECT c.* FROM task_claims c
    JOIN tasks t ON t.task_id = c.task_id
    JOIN plans p ON p.plan_id = t.plan_id
    WHERE ${r.join(" AND ")} ORDER BY c.claimed_at DESC LIMIT 2`).all(...s);return i.length===1?i[0]:null}import{randomUUID as ci}from"node:crypto";function li(t,e){let n=t.prepare("SELECT workspace_path, status FROM plans WHERE plan_id = ?").get(e.planId);if(!n)throw new Error(`plan not found: ${e.planId}`);if(["COMPLETED","CANCELLED"].includes(n.status))throw new Error(`cannot add tasks to ${n.status.toLowerCase()} plan ${e.planId}`);let r=re(e.title,"task title"),s=re(e.reasoning,"task reasoning"),i=re(e.createdBy,"task creator"),a=re(e.acceptanceCriteria,"task acceptance criteria"),o=ur(n.workspace_path,e.paths),c=`task_${ci().replace(/-/g,"")}`,E=I();t.exec("BEGIN IMMEDIATE");try{t.prepare(`INSERT INTO tasks
      (task_id, plan_id, title, reasoning, acceptance_criteria, status, priority, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`).run(c,e.planId,r,s,a,e.priority??0,i,E,E);let _=t.prepare("INSERT INTO task_paths(task_id, path, ordinal) VALUES (?, ?, ?)");o.forEach((l,p)=>_.run(c,l,p)),se(t,c,null,i,"CREATED",s,E);for(let l of e.dependsOn??[])_r(t,{taskId:c,dependsOnTaskId:l,agentId:i});t.exec("COMMIT")}catch(_){try{t.exec("ROLLBACK")}catch{}throw _}return{task:ue(t,c)}}function _r(t,e){if(e.taskId===e.dependsOnTaskId)throw new Error("a task cannot depend on itself");let n=!t.isTransaction;n&&t.exec("BEGIN IMMEDIATE");try{let r=t.prepare(`SELECT t.task_id, t.plan_id, t.status, p.status AS plan_status
      FROM tasks t JOIN plans p ON p.plan_id = t.plan_id
      WHERE t.task_id IN (?, ?)`).all(e.taskId,e.dependsOnTaskId);if(r.length!==2)throw new Error("both dependency tasks must exist");if(r[0].plan_id!==r[1].plan_id)throw new Error("task dependencies must stay within one plan");let s=r.find(E=>E.task_id===e.taskId),i=r.find(E=>E.task_id===e.dependsOnTaskId);if(["COMPLETED","CANCELLED"].includes(s.plan_status))throw new Error(`cannot change dependencies in ${s.plan_status.toLowerCase()} plan ${s.plan_id}`);if(!["OPEN","BLOCKED"].includes(s.status))throw new Error(`cannot change dependencies for task ${e.taskId} with status ${s.status}`);if(i.status==="CANCELLED")throw new Error(`cannot depend on cancelled task ${e.dependsOnTaskId}`);if(t.prepare(`WITH RECURSIVE chain(task_id) AS (
        SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
        UNION
        SELECT td.depends_on_task_id FROM task_dependencies td JOIN chain c ON td.task_id = c.task_id
      ) SELECT 1 FROM chain WHERE task_id = ? LIMIT 1`).get(e.dependsOnTaskId,e.taskId))throw new Error("task dependency would create a cycle");let o=I();t.prepare(`INSERT OR IGNORE INTO task_dependencies
      (task_id, depends_on_task_id, created_by, created_at) VALUES (?, ?, ?, ?)`).run(e.taskId,e.dependsOnTaskId,e.agentId,o).changes>0&&se(t,e.taskId,null,e.agentId,"DEPENDENCY_ADDED",e.dependsOnTaskId,o),n&&t.exec("COMMIT")}catch(r){if(n)try{t.exec("ROLLBACK")}catch{}throw r}}function ui(t,e={}){K(t);let n=["1 = 1"],r=[];e.planId&&(n.push("t.plan_id = ?"),r.push(e.planId)),e.status&&(n.push("t.status = ?"),r.push(e.status)),e.agentId&&(n.push("EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.task_id AND c.agent_id = ?)"),r.push(e.agentId)),e.workspacePath&&(n.push("EXISTS (SELECT 1 FROM plans p WHERE p.plan_id = t.plan_id AND p.workspace_path = ?)"),r.push(e.workspacePath));let s=e.limit==null?null:Math.max(1,Math.floor(e.limit)),i=s==null?"":"LIMIT ?",a=s==null?r:[...r,s];return t.prepare(`SELECT t.* FROM tasks t WHERE ${n.join(" AND ")}
    ORDER BY t.priority DESC, t.created_at, t.task_id ${i}`).all(...a).map(o=>ot(t,o))}function _i(t,e={}){K(t);let n=["1 = 1"],r=[];return e.planId&&(n.push("t.plan_id = ?"),r.push(e.planId)),e.status&&(n.push("t.status = ?"),r.push(e.status)),e.agentId&&(n.push("EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.task_id AND c.agent_id = ?)"),r.push(e.agentId)),e.workspacePath&&(n.push("EXISTS (SELECT 1 FROM plans p WHERE p.plan_id = t.plan_id AND p.workspace_path = ?)"),r.push(e.workspacePath)),t.prepare(`SELECT COUNT(*) AS count FROM tasks t WHERE ${n.join(" AND ")}`).get(...r).count}function Ei(t,e={}){K(t);let n=[],r=e.planId?"AND t.plan_id = ?":"";e.planId&&n.push(e.planId);let s=e.workspacePath?"AND p.workspace_path = ?":"";e.workspacePath&&n.push(e.workspacePath);let i=e.limit==null?null:Math.max(1,Math.floor(e.limit)),a=i==null?"":"LIMIT ?";return i!=null&&n.push(i),t.prepare(`SELECT t.* FROM tasks t JOIN plans p ON p.plan_id = t.plan_id
    WHERE t.status = 'OPEN' AND p.status = 'ACTIVE' ${r} ${s}
      AND NOT EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.task_id)
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks dependency ON dependency.task_id = td.depends_on_task_id
        WHERE td.task_id = t.task_id AND dependency.status <> 'DONE'
      )
    ORDER BY t.priority DESC, t.created_at, t.task_id ${a}`).all(...n).map(c=>ot(t,c))}function di(t,e={}){K(t);let n=[],r=e.planId?"AND t.plan_id = ?":"";e.planId&&n.push(e.planId);let s=e.workspacePath?"AND p.workspace_path = ?":"";return e.workspacePath&&n.push(e.workspacePath),t.prepare(`SELECT COUNT(*) AS count FROM tasks t JOIN plans p ON p.plan_id = t.plan_id
    WHERE t.status = 'OPEN' AND p.status = 'ACTIVE' ${r} ${s}
      AND NOT EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.task_id)
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks dependency ON dependency.task_id = td.depends_on_task_id
        WHERE td.task_id = t.task_id AND dependency.status <> 'DONE'
      )`).get(...n).count}import{randomUUID as pi}from"node:crypto";function fi(t,e){let n=re(e.agentId,"agent id"),r=I(),s=Math.min(Math.max(1,e.leaseMs??$t),Bt),i=new Date(Date.parse(r)+s).toISOString().replace(/\.\d{3}Z$/,"Z"),a=`run_${pi().replace(/-/g,"")}`;t.exec("BEGIN IMMEDIATE");try{K(t,r);let E=t.prepare(`SELECT t.*, p.workspace_path, p.artifact, p.status AS plan_status
      FROM tasks t JOIN plans p ON p.plan_id = t.plan_id WHERE t.task_id = ?`).get(e.taskId);if(!E)return t.exec("ROLLBACK"),{ok:!1,error:`task not found: ${e.taskId}`,task_id:e.taskId};let _=t.prepare("SELECT agent_id FROM task_claims WHERE task_id = ?").get(e.taskId);if(_)return t.exec("ROLLBACK"),{ok:!1,error:`task is already claimed by ${_.agent_id}`,task_id:e.taskId};if(E.plan_status!=="ACTIVE")return t.exec("ROLLBACK"),{ok:!1,error:`task plan is not ACTIVE: status=${String(E.plan_status)}`,task_id:e.taskId};if(E.status!=="OPEN")return t.exec("ROLLBACK"),{ok:!1,error:`task is not ready: status=${String(E.status)}`,task_id:e.taskId};if(t.prepare(`SELECT 1 FROM task_dependencies td
      JOIN tasks dependency ON dependency.task_id = td.depends_on_task_id
      WHERE td.task_id = ? AND dependency.status <> 'DONE' LIMIT 1`).get(e.taskId))return t.exec("ROLLBACK"),{ok:!1,error:"task is blocked by unfinished dependencies",task_id:e.taskId};let p=String(E.workspace_path),d=E.artifact==null?null:String(E.artifact),u=String(E.reasoning),g=String(E.acceptance_criteria),h=String(E.plan_id);e.sessionId&&Ue(t,{sessionId:e.sessionId,agentId:n,workspacePath:p,artifact:d}),t.prepare(`INSERT INTO task_runs
      (run_id, task_id, origin, agent_id, session_id, rationale, test_plan, status, workspace_path, artifact, created_at, updated_at)
      VALUES (?, ?, 'TASK', ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`).run(a,e.taskId,n,e.sessionId??null,u,e.testPlan?.trim()||g,p,d,r,r),t.prepare(`INSERT INTO task_claims(task_id, run_id, agent_id, claimed_at, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(e.taskId,a,n,r,r,i),t.prepare("UPDATE tasks SET status = 'IN_PROGRESS', updated_at = ? WHERE task_id = ?").run(r,e.taskId),t.prepare(`INSERT INTO plan_members(plan_id, agent_id, role, joined_at)
      VALUES (?, ?, 'CONTRIBUTOR', ?) ON CONFLICT(plan_id, agent_id) DO NOTHING`).run(h,n,r),se(t,e.taskId,a,n,"CLAIMED","task claimed",r),t.exec("COMMIT")}catch(E){try{t.exec("ROLLBACK")}catch{}throw E}let o=ue(t,e.taskId),c=t.prepare("SELECT * FROM task_runs WHERE run_id = ?").get(a);return{ok:!0,task:o,run:c,claim:o.claim}}function gi(t,e){let n=I(),r=Math.min(Math.max(1,e.leaseMs??$t),Bt),s=new Date(Date.parse(n)+r).toISOString().replace(/\.\d{3}Z$/,"Z"),i=!1;t.exec("BEGIN IMMEDIATE");try{K(t,n),i=t.prepare(`UPDATE task_claims SET heartbeat_at = ?, expires_at = ?
      WHERE task_id = ? AND run_id = ? AND agent_id = ? AND expires_at > ?`).run(n,s,e.taskId,e.runId,e.agentId,n).changes>0,t.exec("COMMIT")}catch(a){try{t.exec("ROLLBACK")}catch{}throw a}if(!i)throw new Error("active task claim not found for this agent and run");return t.prepare("SELECT * FROM task_claims WHERE task_id = ?").get(e.taskId)}function mi(t,e){let n=I();K(t,n),t.exec("BEGIN IMMEDIATE");try{if(!t.prepare(`SELECT 1 AS ok FROM task_claims
       WHERE task_id = ? AND run_id = ? AND agent_id = ? AND expires_at > ?`).get(e.taskId,e.runId,e.agentId,n))throw t.exec("ROLLBACK"),new Error("only the active claimant can submit this task");t.prepare("DELETE FROM locks WHERE run_id = ?").run(e.runId),t.prepare(`UPDATE run_files SET heartbeat_at = ?, expires_at = ?, ended_at = ?
      WHERE run_id = ? AND ended_at IS NULL`).run(n,n,n,e.runId),t.prepare("UPDATE task_runs SET status = 'PENDING', updated_at = ? WHERE run_id = ? AND status = 'ACTIVE'").run(n,e.runId),t.prepare("UPDATE tasks SET status = 'VERIFY', updated_at = ? WHERE task_id = ?").run(n,e.taskId),t.prepare("DELETE FROM task_claims WHERE task_id = ?").run(e.taskId),se(t,e.taskId,e.runId,e.agentId,"SUBMITTED",e.message?.trim()||"submitted for verification",n),t.exec("COMMIT")}catch(r){try{t.exec("ROLLBACK")}catch{}throw r}return{task:ue(t,e.taskId),run:t.prepare("SELECT * FROM task_runs WHERE run_id = ?").get(e.runId)}}function Ti(t,e){let n=I(),r=e.blockedReason?.trim();K(t,n),t.exec("BEGIN IMMEDIATE");try{if(!t.prepare(`SELECT 1 AS ok FROM task_claims
       WHERE task_id = ? AND run_id = ? AND agent_id = ? AND expires_at > ?`).get(e.taskId,e.runId,e.agentId,n))throw t.exec("ROLLBACK"),new Error("only the active claimant can release this task");t.prepare("DELETE FROM locks WHERE run_id = ?").run(e.runId),t.prepare(`UPDATE run_files SET heartbeat_at = ?, expires_at = ?, ended_at = ?
      WHERE run_id = ? AND ended_at IS NULL`).run(n,n,n,e.runId),t.prepare("UPDATE task_runs SET status = 'FAILED', updated_at = ? WHERE run_id = ? AND status = 'ACTIVE'").run(n,e.runId),t.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(r?"BLOCKED":"OPEN",n,e.taskId),t.prepare("DELETE FROM task_claims WHERE task_id = ?").run(e.taskId),se(t,e.taskId,e.runId,e.agentId,r?"BLOCKED":"RELEASED",r||"claim released",n),t.exec("COMMIT")}catch(s){try{t.exec("ROLLBACK")}catch{}throw s}return ue(t,e.taskId)}import{randomUUID as pr}from"node:crypto";import{createHash as Si}from"node:crypto";var Er=`
  INSERT INTO edit_log (
    edit_id, session_id, run_id, agent_id,
    file_path, operation, old_file_path,
    lines_added, lines_removed, content_hash,
    workspace_path, artifact, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;var dr=`
  INSERT INTO harness_log (
    harness_id, session_id, agent_id, workspace_path, artifact, event_type,
    payload_json, memory_id, run_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;function Bc(t){return Si("sha256").update(t).digest("hex")}function jc(t,e){let n="edit_"+pr(),r=I();return t.prepare(Er).run(n,e.sessionId??null,e.runId??null,e.agentId,e.filePath,e.operation,e.oldFilePath??null,e.linesAdded??null,e.linesRemoved??null,e.contentHash??null,e.workspacePath??null,R(e.artifact),r),{editId:n}}function Yc(t,e){let n=[],r=[];e.sessionId!==void 0&&(n.push("session_id = ?"),r.push(e.sessionId)),e.runId!==void 0&&(n.push("run_id = ?"),r.push(e.runId)),e.agentId!==void 0&&(n.push("agent_id = ?"),r.push(e.agentId)),e.filePath!==void 0&&(n.push("file_path = ?"),r.push(e.filePath)),e.workspacePath!==void 0&&(n.push("workspace_path = ?"),r.push(e.workspacePath));let s=R(e.artifact);s!==null&&(n.push("artifact = ?"),r.push(s)),e.operation!==void 0&&(n.push("operation = ?"),r.push(e.operation)),e.since!==void 0&&(n.push("created_at >= ?"),r.push(e.since));let i=n.length>0?`WHERE ${n.join(" AND ")}`:"",a=e.limit!==void 0?`LIMIT ${e.limit}`:"",o=`SELECT * FROM edit_log ${i} ORDER BY created_at DESC ${a}`.trim();return t.prepare(o).all(...r)}function Gc(t,e){let n="harness_"+pr(),r=I(),s=e.payload!==void 0?JSON.stringify(e.payload):null;return t.prepare(dr).run(n,e.sessionId??null,e.agentId,e.workspacePath??null,R(e.artifact),e.eventType,s,e.memoryId??null,e.runId??null,r),n}function Vc(t,e){let n=[],r=[];e.sessionId!==void 0&&(n.push("session_id = ?"),r.push(e.sessionId)),e.agentId!==void 0&&(n.push("agent_id = ?"),r.push(e.agentId)),e.workspacePath!==void 0&&(n.push("workspace_path = ?"),r.push(e.workspacePath));let s=R(e.artifact);s!==null&&(n.push("artifact = ?"),r.push(s)),e.eventType!==void 0&&(n.push("event_type = ?"),r.push(e.eventType));let i=n.length>0?`WHERE ${n.join(" AND ")}`:"",a=e.limit!==void 0?`LIMIT ${e.limit}`:"",o=`SELECT * FROM harness_log ${i} ORDER BY created_at DESC ${a}`.trim();return t.prepare(o).all(...r)}import{isAbsolute as hi,resolve as jt}from"node:path";var Yt=20,Ni=10,fr=3,gr=3,Ii=120,mr=36e5,Tr=3e5,Sr=6e4,hr=5e3;function Gt(t,e=Ii){let n=t.replace(/\s+/g," ").trim();return n.length>e?`${n.slice(0,e-3)}...`:n}function Vt(t,e,n=Ni){if(e.length===0)return null;let r=e.slice(0,n),s=e.length-r.length;return`${t}${s>0?` (showing ${r.length} of ${e.length})`:""}: ${r.join(", ")}${s>0?`; ${s} omitted`:""}.`}function Kt(t,e,n,r){if(t==null)return e;let s=Number(t);return Number.isFinite(s)?Math.min(Math.max(s,n),r):n}function ct(t,e={}){let n=!!(e.dry_run??e.dryRun),r=!!(e.expired_only??e.expiredOnly),s=e.older_than_minutes!=null?Number(e.older_than_minutes):e.olderThanMinutes!=null?Number(e.olderThanMinutes):null,i=typeof e.agent_id=="string"?e.agent_id:typeof e.agentId=="string"?e.agentId:null,a=typeof e.workspace=="string"?e.workspace:typeof e.workspace_path=="string"?e.workspace_path:typeof e.workspacePath=="string"?e.workspacePath:null,o=a?y(a,a):null,c=R(e.artifact),E=e.target_file??e.targetFile,_=(Array.isArray(E)?E:E!=null?[E]:[]).map(String).filter(Boolean).map(m=>{let L=a?jt(a):process.cwd();return q(hi(m)?jt(m):jt(L,m))}),l=I(),p=s!=null&&!r?new Date(Date.now()-s*6e4).toISOString():null,d=[],u=[],g=["(l.expires_at IS NOT NULL AND l.expires_at < ?)"];u.push(l),p&&(g.push("(l.acquired_at < ?)"),u.push(p)),d.push(`(${g.join(" OR ")})`),i&&(d.push("t.agent_id = ?"),u.push(i)),_.length>0&&(d.push(`l.file_path IN (${_.map(()=>"?").join(",")})`),u.push(..._)),o&&(d.push("t.workspace_path = ?"),u.push(o)),c&&(d.push("(t.artifact = ? OR t.artifact IS NULL)"),u.push(c));let h=d.join(" AND "),f="locks l JOIN task_runs t ON t.run_id = l.run_id",T=[];try{T=t.prepare(`SELECT l.lock_id, l.run_id, l.file_path, t.agent_id, t.rationale AS reason, l.expires_at
         FROM ${f} WHERE ${h}`).all(...u)}catch{}if(n)return{pruned_locks:0,dry_run:!0,would_prune:T.length,locks:T.slice(0,20).map(m=>({path:m.file_path,agent:m.agent_id,state:"expired",reason:m.reason,run_id:m.run_id,expires_at:m.expires_at}))};if(T.length===0)return{pruned_locks:0};let S=!t.isTransaction;S&&t.exec("BEGIN IMMEDIATE");try{if(T=t.prepare(`SELECT l.lock_id, l.run_id, l.file_path, t.agent_id, t.rationale AS reason, l.expires_at
         FROM ${f} WHERE ${h}`).all(...u),T.length===0)return S&&t.exec("COMMIT"),{pruned_locks:0};let m=T.map(()=>"?").join(",");t.prepare(`DELETE FROM locks WHERE lock_id IN (${m})`).run(...T.map(L=>L.lock_id)),S&&t.exec("COMMIT")}catch(m){if(S)try{t.exec("ROLLBACK")}catch{}throw m}return{pruned_locks:T.length}}function ve(t,e={}){let n=F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:e.repo??null,ref:e.ref??null},e.cwd??process.cwd()),r=[],s="SELECT COUNT(*) AS c FROM refinements WHERE state IN ('open','ongoing')";return e.includeHandoffs||(s+=" AND quality NOT IN ('handoff','instructions')"),n.workspace_path&&(s+=" AND (workspace_path = ? OR workspace_path IS NULL)",r.push(n.workspace_path)),n.artifact&&(s+=" AND (artifact = ? OR artifact IS NULL)",r.push(n.artifact)),n.repo&&(s+=" AND (repo = ? OR repo IS NULL)",r.push(n.repo)),n.ref&&(s+=" AND (ref = ? OR ref IS NULL)",r.push(n.ref)),t.prepare(s).get(...r).c}import{randomUUID as Ri}from"node:crypto";var Nr="SELECT run_id FROM task_runs WHERE status = 'PENDING' AND agent_id = ? {DYNAMIC_WHERE}",Ir="SELECT agent_id, status, workspace_path FROM task_runs WHERE run_id = ?",qt="UPDATE task_runs SET status = ?, updated_at = ? WHERE run_id = ? AND agent_id = ? AND status = 'PENDING'",Rr="UPDATE task_runs SET status = ?, updated_at = ? WHERE run_id = ? AND workspace_path = ? AND status = 'PENDING'";var lt="UPDATE task_runs SET status = 'FAILED', updated_at = ? WHERE run_id = ? AND status = 'ACTIVE'",_e=`INSERT INTO run_log(event_id, run_id, agent_id, event_type, message, created_at)
   VALUES (?, ?, ?, 'VERIFIED', ?, ?)`;var Lr="SELECT thread_id FROM signals WHERE signal_id = ?",Ar=`INSERT INTO signals
   (signal_id, workspace_path, artifact, repo, ref, from_agent, to_agent, kind, subject, body,
    files_json, refs_json, thread_id, reply_to, importance, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,Or="SELECT n.* FROM signals n",kr="LEFT JOIN signal_reads nr ON nr.signal_id = n.signal_id AND nr.agent_id = ?",yr="ORDER BY n.created_at DESC LIMIT ?",wr=t=>`DELETE FROM signals WHERE signal_id IN (${t})`;var ut="INSERT OR IGNORE INTO signal_reads(signal_id, agent_id, read_at) VALUES (?, ?, ?)",Dr=t=>`DELETE FROM signal_reads WHERE signal_id IN (${t})`;var Cr=`INSERT INTO agents (agent_id, agent_name, workspace_path, artifact, context, registered_at, last_seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(agent_id) DO UPDATE SET
     agent_name     = CASE WHEN excluded.agent_name <> '' THEN excluded.agent_name ELSE agent_name END,
     workspace_path = COALESCE(excluded.workspace_path, workspace_path),
     artifact       = COALESCE(excluded.artifact, artifact),
     context        = COALESCE(excluded.context, context),
     last_seen_at   = excluded.last_seen_at`;var xr="UPDATE agents SET last_seen_at = ?, workspace_path = COALESCE(?, workspace_path), artifact = COALESCE(?, artifact) WHERE agent_id = ?",Mr="SELECT agent_name FROM agents WHERE agent_id = ?",Fr="SELECT agent_id, agent_name FROM agents WHERE agent_id IN ",Pr="AND agent_name <> ''",Ur=`SELECT agent_id, agent_name, workspace_path, artifact, context, registered_at, last_seen_at
   FROM agents`,br="(workspace_path = ? OR workspace_path IS NULL)",vr="(artifact = ? OR artifact IS NULL)",Wr="ORDER BY last_seen_at DESC";var Xr="refinement_id, agent_id, workspace_path, artifact, repo, ref, files_json, reasoning, remember, quality, state, created_at, updated_at",rl=`INSERT INTO refinements (
     refinement_id, agent_id, workspace_path, artifact, repo, ref,
     files_json, reasoning, remember, quality, state, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,sl=`SELECT ${Xr} FROM refinements
   WHERE state IN ('open','ongoing') AND quality NOT IN ('handoff','instructions')
   ORDER BY CASE state WHEN 'ongoing' THEN 0 ELSE 1 END, updated_at DESC`,il=`SELECT ${Xr} FROM refinements
   WHERE (workspace_path = ? OR workspace_path IS NULL)
   ORDER BY CASE state WHEN 'ongoing' THEN 0 ELSE 1 END, updated_at DESC`;var al="DELETE FROM refinements WHERE refinement_id IN ";function Hr(t){return{signal_id:t.signal_id,workspace_path:t.workspace_path,artifact:t.artifact,repo:t.repo,ref:t.ref,from_agent:t.from_agent,to_agent:t.to_agent,kind:t.kind,subject:t.subject,body:t.body,files:j(t.files_json),refs:j(t.refs_json),thread_id:t.thread_id,reply_to:t.reply_to,importance:t.importance,status:t.status,created_at:t.created_at}}function We(t,e){let{agentId:n,toAgent:r=null,kind:s,subject:i,body:a=null,files:o=[],refIds:c=[],inReplyTo:E=null,importance:_=5,cwd:l}=e,p=ln(s);if(!Number.isInteger(_)||_<1||_>10)throw new Error(`importance must be an integer between 1 and 10, got ${String(_)}`);let d=F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:e.repo??null,ref:e.ref??null},l??process.cwd()),u="ntf_"+Ri().replace(/-/g,""),g=I(),h=d.workspace_path??process.cwd(),f;if(E){let T=t.prepare(Lr).get(E);if(!T)throw new Error(`insertNotification: parent signal ${E} not found (deleted?). Omit inReplyTo to start a new thread.`);if(!zt(t,T.thread_id,n))throw new Error(`insertNotification: agent ${n} is not a participant in thread ${T.thread_id}`);f=T.thread_id}else f=u;return t.prepare(Ar).run(u,h,d.artifact,d.repo,d.ref,n,r,p,i,a,JSON.stringify(o),JSON.stringify(c),f,E,_,g),{signal_id:u,thread_id:f,workspace_path:h,artifact:d.artifact}}function Ee(t,e,n,r="n"){let s=r?`${r}.`:"";n.workspace_path&&(t.push(`(${s}workspace_path = ? OR ${s}workspace_path IS NULL)`),e.push(n.workspace_path)),n.artifact&&(t.push(`(${s}artifact = ? OR ${s}artifact IS NULL)`),e.push(n.artifact)),n.repo&&(t.push(`(${s}repo = ? OR ${s}repo IS NULL)`),e.push(n.repo)),n.ref&&(t.push(`(${s}ref = ? OR ${s}ref IS NULL)`),e.push(n.ref))}function $r(t,e){return t.prepare(`SELECT 1 FROM signals
    WHERE thread_id = ? AND reply_to IS NULL AND to_agent IS NULL
    LIMIT 1`).get(e)!=null}function Oe(t,e,n){return t.prepare(`SELECT 1 FROM signals
    WHERE thread_id = ? AND (from_agent = ? OR to_agent = ?)
    LIMIT 1`).get(e,n,n)!=null?!0:$r(t,e)?t.prepare(`SELECT 1 FROM signal_reads read
    JOIN signals signal ON signal.signal_id = read.signal_id
    WHERE signal.thread_id = ? AND read.agent_id = ?
    LIMIT 1`).get(e,n)!=null:!1}function zt(t,e,n){return $r(t,e)||Oe(t,e,n)}function Br(t,e,n){let r=t.prepare("SELECT thread_id FROM signals WHERE signal_id = ?").get(e);if(!r)throw new Error(`insertNotification: parent signal ${e} not found (deleted?). Omit inReplyTo to start a new thread.`);let s=t.prepare("SELECT from_agent, to_agent FROM signals WHERE thread_id = ?").all(r.thread_id),i=new Set;for(let a of s)i.add(a.from_agent),a.to_agent&&i.add(a.to_agent);if(i.delete(n),i.size===0)throw new Error("agent_signal reply has no inferred recipient; pass --to-agent");return[...i].sort()}function Xe(t,e){let{agentId:n,kinds:r=[],signalIds:s=[],threadId:i=null,unreadOnly:a=!0,markRead:o=!1,limit:c=20,cwd:E}=e,_=F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:e.repo??null,ref:e.ref??null},E??process.cwd());if(i&&!zt(t,i,n))return{count:0,signals:[],unread_only:a};let l=[],p=[];Ee(l,p,_),i?(l.push("n.thread_id = ?"),p.push(i),a&&(l.push("n.status = 'open'"),l.push("nr.signal_id IS NULL"))):(l.push("(n.to_agent = ? OR (n.to_agent IS NULL AND (n.from_agent <> ? OR n.kind = 'handoff')))"),p.push(n,n),a&&(l.push("n.status = 'open'"),l.push("nr.signal_id IS NULL"))),r.length>0&&(l.push(`n.kind IN (${r.map(()=>"?").join(",")})`),p.push(...r)),s.length>0&&(l.push(`n.signal_id IN (${s.map(()=>"?").join(",")})`),p.push(...s));let d=l.length>0?`WHERE ${l.join(" AND ")}`:"",u=a?kr:"",g=a?[n,...p]:p,h=`
    ${Or}
    ${u}
    ${d}
    ${yr}
  `,f=Math.min(200,Math.max(1,Math.floor(Number.isFinite(c)?c:20))),S=t.prepare(h).all(...g,f).map(Hr);if(o&&S.length>0){let m=I(),L=t.prepare(ut);for(let A of S)L.run(A.signal_id,n,m)}return{count:S.length,signals:S,unread_only:a}}function Zt(t,e){let{notificationIds:n=[],threadId:r=null,cwd:s,agentId:i=null}=e;Jt(t,n);let o=e.workspacePath!=null||e.artifact!=null?F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:null,ref:null},s??process.cwd()):{workspace_path:null,artifact:null,repo:null,ref:null},c=[],E=I();if(n.length>0){let l=[`signal_id IN (${n.map(()=>"?").join(",")})`,"status = 'open'"],p=[...n];if(Ee(l,p,o,""),i){let u=n.filter(g=>{let h=t.prepare("SELECT thread_id FROM signals WHERE signal_id = ?").get(g);return h?Oe(t,h.thread_id,i):!1});if(u.length===0)return{resolved:0,signal_ids:[]};l.push(`signal_id IN (${u.map(()=>"?").join(",")})`),p.push(...u)}let d=t.prepare(`UPDATE signals SET status = 'resolved', resolved_at = ? WHERE ${l.join(" AND ")} RETURNING signal_id`).all(E,...p);c.push(...d.map(u=>u.signal_id))}if(r){if(i&&!Oe(t,r,i))return{resolved:c.length,signal_ids:[...new Set(c)]};let _=["thread_id = ?","status = 'open'"],l=[r];Ee(_,l,o,"");let p=t.prepare(`UPDATE signals SET status = 'resolved', resolved_at = ? WHERE ${_.join(" AND ")} RETURNING signal_id`).all(E,...l);c.push(...p.map(d=>d.signal_id))}return{resolved:c.length,signal_ids:[...new Set(c)]}}function Li(t){return{...t,to_agents:t.to_agent?[t.to_agent]:[]}}function jr(t,e){if(typeof t!="string"||t.trim().length===0)throw new Error(`agent_signal ${e} is required`);return t}function Jt(t,e){if(e.length===0)return;let n=[...new Set(e)],r=t.prepare(`SELECT signal_id FROM signals WHERE signal_id IN (${n.map(()=>"?").join(",")})`).all(...n),s=new Set(r.map(a=>a.signal_id)),i=n.filter(a=>!s.has(a));if(i.length>0)throw new Error(`signal(s) not found: ${i.join(", ")}`)}function Ai(t,e,n=[],r=null,s={}){Jt(t,n);let i=["status = 'open'","(to_agent IS NULL OR to_agent = ?)","from_agent <> ?"],a=[e,e];n.length>0&&(i.push(`signal_id IN (${n.map(()=>"?").join(",")})`),a.push(...n)),r&&(i.push("thread_id = ?"),a.push(r));let o=F({workspace_path:s.workspacePath??null,artifact:R(s.artifact),repo:null,ref:null},s.cwd??process.cwd());n.length===0&&Ee(i,a,o,"");let E=t.prepare(`SELECT signal_id FROM signals WHERE ${i.join(" AND ")}`).all(...a).map(u=>u.signal_id),_=[...new Set(E)];if(_.length===0)return{acknowledged:0,signal_ids:[]};let l=I(),p=t.prepare(ut),d=0;for(let u of _){let g=p.run(u,e,l);d+=g.changes}return{acknowledged:d,signal_ids:_}}function Oi(t,e){switch(e.action){case"publish":case"reply":{let r=(e.toAgents?.length?e.toAgents:e.action==="reply"?Br(t,jr(e.inReplyTo,"inReplyTo"),e.agentId):[null]).map(s=>We(t,{agentId:e.agentId,workspacePath:e.workspacePath,artifact:e.artifact,repo:e.repo,ref:e.ref,toAgent:s,kind:e.action==="reply"?"reply":e.kind??"fyi",subject:jr(e.subject,"subject"),body:e.body??null,files:e.files??[],refIds:e.refs??[],inReplyTo:e.inReplyTo??null,importance:e.importance??5,cwd:e.cwd}));return{action:e.action,signal_id:r[0].signal_id,signal_ids:r.map(s=>s.signal_id),thread_id:r[0].thread_id,workspace_path:r[0].workspace_path,artifact:r[0].artifact}}case"list":{let n=Xe(t,{agentId:e.agentId,workspacePath:e.workspacePath,artifact:e.artifact,repo:e.repo,ref:e.ref,kinds:e.kinds??[],signalIds:e.signalIds??[],threadId:e.threadId??null,unreadOnly:e.unreadOnly??!0,markRead:e.markRead??!1,limit:e.limit??20,cwd:e.cwd});return{action:"list",count:n.count,signals:n.signals.map(Li),unread_only:n.unread_only}}case"resolve":return{action:"resolve",...Zt(t,{agentId:e.agentId,notificationIds:e.signalIds??[],threadId:e.threadId??null,workspacePath:e.workspacePath,artifact:e.artifact,cwd:e.cwd})};case"ack":return{action:"ack",...Ai(t,e.agentId,e.signalIds??[],e.threadId??null,{workspacePath:e.workspacePath,artifact:e.artifact,cwd:e.cwd})}}}function ki(t,e){let{agentId:n,notificationIds:r=[],resolvedOnly:s=!1,olderThanDays:i,dryRun:a=!1,cwd:o}=e;if(!s)throw new Error("signal prune only deletes resolved messages");if(i==null||!Number.isFinite(i)||i<1)throw new Error("signal prune requires --older-than-days >= 1");let c=F({workspace_path:e.workspacePath??null,artifact:R(e.artifact),repo:null,ref:null},o??process.cwd()),E=["status = 'resolved'","created_at < ?"],_=[];_.push(new Date(Date.now()-Math.floor(i)*864e5).toISOString()),r.length>0&&(E.push(`signal_id IN (${r.map(()=>"?").join(",")})`),_.push(...r)),Ee(E,_,c,"");let l=E.join(" AND "),d=t.prepare(`SELECT signal_id, thread_id FROM signals WHERE ${l}`).all(..._).filter(u=>Oe(t,u.thread_id,n)).map(u=>u.signal_id);if(a)return{deleted:0,dry_run:!0,would_delete:d.length,signal_ids:d};if(d.length>0){let u=d.map(()=>"?").join(",");t.prepare(wr(u)).run(...d),t.prepare(Dr(u)).run(...d)}return{deleted:d.length,signal_ids:d}}import{createHash as Ci}from"node:crypto";function He(t,e){let n=t.replace(/\s+/g," ").trim();if(Buffer.byteLength(n,"utf8")<=e)return n;let r="...",s=Buffer.byteLength(r,"utf8"),i=0,a="";for(let o of n){let c=Buffer.byteLength(o,"utf8");if(i+c+s>e)break;a+=o,i+=c}return a.trimEnd()+r}function yi(t,e){let n=t.trim();if(!e)return n;let r=e.endsWith("/")?e:`${e}/`;return n.startsWith(r)?n.slice(r.length):n}function wi(t,e){let n=[...new Set(t.map(i=>yi(i,e)).filter(Boolean))];if(n.length===0)return"";let r=He(n[0],56),s=n.length>1?` (+${n.length-1})`:"";return`files ${n.length}: ${r}${s}`}function Di(t,e){return[`from ${t}`,e]}function Qt(t){let n=[`\u{1F4E8} ${t.count&&t.count>1?`${t.kind} \xD7${t.count}`:t.kind}`,...Di(t.from,t.target),He(t.subject,72),wi(t.files,t.workspacePath)].filter(Boolean),r=t.body?` \u2014 ${He(t.body,60)}`:"";return`${n.join(" \xB7 ")}${r}`}function Yr(t){let e=new Map;for(let n of t){let r=`${n.kind}\0${n.text}`,s=e.get(r);if(s){s.duplicateCount+=1,s.importance=Math.max(s.importance??0,n.importance??0)||void 0;continue}e.set(r,{...n,duplicateCount:1})}return[...e.values()].map(({duplicateCount:n,...r})=>n>1?{...r,text:`${r.text} (duplicate \xD7${n})`}:r)}var en=["GOTCHA","BUG","DECISION","IMPROVEMENT","ARCHITECTURE","SECURITY"],xi=50,Mi=180,Fi=5,Pi=new Set(["the","and","for","with","from","into","this","that","about","before","after","fix","update","change","make","during"]);function Gr(t){return new Set((t.toLowerCase().match(/[a-z0-9]{3,}/g)??[]).filter(e=>!Pi.has(e)))}function Ui(t,e){let n=Gr(t);if(n.size<2)return!1;let r=Gr([e.task_context,e.observation,e.label,e.failure_signature??""].join(" ")),s=0;for(let i of n)if(r.has(i)&&++s>=2)return!0;return!1}function bi(t,e={}){let n=e.workspace??null,r=R(e.artifact),s=e.format??"json",i=String(e.query??"").trim().slice(0,4e3),a=String(e.agent_id??e.agentId??"agent"),o=n??e.cwd??process.cwd(),c=[];try{let _=Xe(t,{agentId:a,workspacePath:n,artifact:r,unreadOnly:!0,markRead:!1,limit:50,cwd:o}),l=new Map,p=u=>{let g=u.replace(/Review session handoff for pi:[^\s:]+(?::[^\s]+)?/g,"Review session handoff");return/^Review session handoff(?:\b|:)/.test(g)?"Review session handoff":g},d=u=>Ye(u.replace(/pi:[^\s]+/g,"pi:<session>"),120);for(let u of _.signals){let g=u.to_agent?`to ${u.to_agent}`:"broadcast";if(u.kind==="handoff"){let f=p(u.subject),T=f==="Review session handoff",S=T?"":d(u.body??""),m=JSON.stringify([u.kind,u.to_agent??"",f,T?"":S]),L=l.get(m);if(L){L.count+=1,L.files.push(...u.files),L.importance=Math.max(L.importance,u.importance);continue}l.set(m,{count:1,from:u.from_agent,target:g,subject:f,body:S,files:[...u.files],importance:u.importance});continue}let h=Qt({kind:u.kind,from:u.from_agent,target:g,files:u.files,subject:u.subject,body:u.body??void 0,workspacePath:n});c.push({kind:"notification",text:h,importance:u.importance})}for(let u of l.values()){let g=u.count>1?"multiple agents":u.from;c.push({kind:"notification",text:Qt({kind:"handoff",count:u.count,from:g,target:u.target,files:u.files,subject:u.subject,body:u.body,workspacePath:n}),importance:u.importance})}}catch{}try{let _=["state = 'ACTIVE'","label = 'OVERRIDE'"],l=[];n&&(_.push("(workspace_path = ? OR workspace_path IS NULL)"),l.push(n)),r&&(_.push("(artifact = ? OR artifact IS NULL)"),l.push(r));let p=t.prepare(`SELECT memory_id, observation, importance
       FROM memories
       WHERE ${_.join(" AND ")}
       ORDER BY importance DESC, last_accessed_at DESC
       LIMIT 2`).all(...l);for(let d of p)c.push({kind:"memory",text:`OVERRIDE(${d.importance}): ${d.observation.slice(0,120)}`,importance:d.importance})}catch{}try{let _=[];if(s==="hook"){if(i){let p=bt(t,{query:i,limit:xi,minImportance:6,label:[...en],workspacePath:n,artifact:r,repo:e.repo??null,ref:e.ref??null,recordAccess:!1,cwd:o}).memories.find(d=>Ui(i,d));p&&(_=[p])}}else{let l=["state = 'ACTIVE'","importance >= 6",`label IN (${en.map(()=>"?").join(",")})`],p=[...en];n&&(l.push("(workspace_path = ? OR workspace_path IS NULL)"),p.push(n)),r&&(l.push("(artifact = ? OR artifact IS NULL)"),p.push(r)),_=t.prepare(`SELECT memory_id, task_context, observation, label, importance, failure_signature
         FROM memories
         WHERE ${l.join(" AND ")}
         ORDER BY importance DESC, last_accessed_at DESC
         LIMIT 3`).all(...p)}for(let l of _)c.push({kind:"memory",text:`Memory lead \u2014 verify: ${l.label}(${l.importance}): ${l.observation.slice(0,120)}`,importance:l.importance})}catch{}try{let _=["failure_signature IS NOT NULL","state = 'ACTIVE'"],l=[];n&&(_.push("(workspace_path = ? OR workspace_path IS NULL)"),l.push(n)),r&&(_.push("(artifact = ? OR artifact IS NULL)"),l.push(r));let p=t.prepare(`SELECT failure_signature, count(*) AS freq, avg(importance) AS avg_imp
       FROM memories
       WHERE ${_.join(" AND ")}
       GROUP BY failure_signature HAVING freq >= 2
       ORDER BY freq * avg_imp DESC LIMIT 1`).get(...l);p&&c.push({kind:"weakness",text:`\u26A0\uFE0F Recurring: ${p.failure_signature} (${p.freq}x, avg imp ${Math.round(p.avg_imp)})`})}catch{}try{let _=ve(t,{workspacePath:n,artifact:r,cwd:o});_>0&&c.push({kind:"refinement",text:`\u{1F4CB} ${_} open refinement(s) pending`})}catch{}if(c.length===0)return{ok:!0,count:0,notifications:[]};let E={ok:!0,count:c.length,notifications:c};if(s==="hook"){let _=Yr(c),l=_.slice(0,Fi).map(w=>({...w,text:He(w.text,Mi)}));E.count=l.length,E.notifications=l;let p=Math.max(0,_.length-l.length),d=Math.max(0,c.length-_.length),u=[c.length>l.length?`${c.length} total`:"",d>0?`${d} duplicate${d===1?"":"s"} collapsed`:"",p>0?`${p} more not shown`:""].filter(Boolean),g=u.length>0?` \u2014 ${u.join(" \xB7 ")}`:"",f=[`\u{1F9E0} Brief \u2014 showing ${l.length}/${Math.max(c.length,l.length)}${g}:`,...l.map(w=>`  \u2022 ${w.text}`)].join(`
`),T=String(e.session_id??e.sessionId??"-"),S=F({workspace_path:n,artifact:r,repo:e.repo??null,ref:e.ref??null},o),m=JSON.stringify([T,S.workspace_path,S.artifact,S.repo,S.ref]),L=Ci("sha256").update(f).digest("hex"),A={consumerId:a,channel:"briefing",scopeKey:m};if(Rt(t,A)===L)return{ok:!0,count:0,notifications:[]};Lt(t,{...A,fingerprint:L}),E.additionalContext=f}return E}import{isAbsolute as Wi,resolve as _t}from"node:path";import{spawnSync as vi}from"node:child_process";function Vr(t){let e=[];for(let n of String(t).split(`
`)){if(!n||n.length<4)continue;let r=n.slice(0,2),s=n.slice(3);if(r.includes("R")||r.includes("C")){let a=s.indexOf(" -> ");a>=0&&(s=s.slice(a+4))}let i=s.trim();i&&e.push(i)}return e}function Kr(t){if(!t)return[];try{let e=vi("git",["-C",t,"status","--porcelain=v1"],{encoding:"utf8",timeout:5e3});return e.status!==0?[]:Vr(String(e.stdout))}catch{return[]}}function Xi(t,e={}){let n=String(e.agent_id??e.agentId??"agent"),r=e.reason?String(e.reason):null,s=e.workspace??e.workspace_path??e.workspacePath,i=typeof s=="string"&&s.trim()?_t(s.trim()):null,a=F({workspace_path:i,artifact:R(e.artifact),repo:e.repo??null,ref:e.ref??null},e.cwd??process.cwd()),o=a.workspace_path??i??process.cwd(),c=[...new Set([o,i].filter(k=>!!k))],E=a.artifact,_=c.map(()=>"?").join(","),l=t.prepare(`SELECT tr.run_id, tr.rationale, tr.test_plan, tr.context_ref, tr.status, tr.created_at, tr.updated_at,
            COALESCE((SELECT json_group_array(rf.file_path)
              FROM run_files rf WHERE rf.run_id = tr.run_id), '[]') AS files_json
     FROM task_runs tr
     WHERE tr.agent_id = ?
       AND status IN ('ACTIVE', 'PENDING')
       AND (workspace_path IN (${_}) OR workspace_path IS NULL)
       AND (? IS NULL OR artifact = ? OR artifact IS NULL)
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 20`).all(n,...c,E,E),p=[...new Set(l.flatMap(k=>j(k.files_json)))],d=Kr(o),u=l.filter(k=>k.status==="ACTIVE").length,g=l.filter(k=>k.status==="PENDING").length,h=0;try{let k=["novelty_score IS NOT NULL","novelty_score < 0.2","state = 'ACTIVE'"],D=[];o&&(k.push("(workspace_path = ? OR workspace_path IS NULL)"),D.push(o)),E&&(k.push("(artifact = ? OR artifact IS NULL)"),D.push(E)),h=t.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${k.join(" AND ")}`).get(...D).c}catch{}if(l.length===0&&d.length===0)return{ok:!0,captured:!1,signal_id:null,pending_runs:0,active_runs:0,files:[],dirty_files:[],reason:r,consolidation_opportunities:h};let f=[...new Set([...p,...d])],T=f.slice(0,Yt),S=d.slice(0,Yt),m=l.slice(0,fr).map(k=>{let D=j(k.files_json),U=D.slice(0,gr),M=D.length-U.length,B=D.length>0?` files=${U.join(", ")}${M>0?` (+${M} more)`:""}`:"",H=k.context_ref?` plan=${k.context_ref}`:"";return`${k.status} ${k.run_id}: ${Gt(k.rationale)}; verify=${Gt(k.test_plan)}${H}${B}`}),L=l.length-m.length,A=[`Session capture for ${n}${r?` (${r})`:""}.`,`Unresolved runs: ${l.length} (${u} active, ${g} pending).`,Vt("Dirty files",d),m.length>0?`Run details: ${m.join(" | ")}${L>0?` | ${L} more runs omitted`:""}`:null].filter(Boolean).join(" "),w=[`Review session handoff for ${n}: ${u} active and ${g} pending runs remain.`,Vt("Touched files",f),d.length>0?"Check dirty git state before continuing.":null,g>0?"Run the recorded verification before claiming completion.":null].filter(Boolean).join(" "),v=t.prepare(`SELECT signal_id FROM signals
      WHERE from_agent = ? AND workspace_path = ? AND artifact IS ? AND repo IS ? AND ref IS ?
        AND kind = 'handoff' AND status = 'open'
        AND files_json = ? AND subject = ? AND body = ?
      ORDER BY datetime(created_at) DESC LIMIT 1`).get(n,o,E,a.repo,a.ref,JSON.stringify(T),w,A);return v?{ok:!0,captured:!1,deduplicated:!0,signal_id:v.signal_id,pending_runs:g,active_runs:u,files:T,dirty_files:S,file_count:f.length,dirty_file_count:d.length,omitted_files:Math.max(0,f.length-T.length),omitted_dirty_files:Math.max(0,d.length-S.length),reason:r,consolidation_opportunities:h}:{ok:!0,captured:!0,signal_id:We(t,{agentId:n,toAgent:null,kind:"handoff",subject:w,body:A,files:T,importance:g>0?7:5,workspacePath:o,artifact:E,repo:a.repo,ref:a.ref,cwd:o}).signal_id,pending_runs:g,active_runs:u,files:T,dirty_files:S,file_count:f.length,dirty_file_count:d.length,omitted_files:Math.max(0,f.length-T.length),omitted_dirty_files:Math.max(0,d.length-S.length),reason:r,consolidation_opportunities:h}}function Hi(t,e={}){let n=Array.isArray(e.target_files)?e.target_files:Array.isArray(e.targetFiles)?e.targetFiles:[],r=e.agent_id??e.agentId??"agent",s=typeof e.workspace=="string"?e.workspace:typeof e.workspace_path=="string"?e.workspace_path:typeof e.workspacePath=="string"?e.workspacePath:null,i=s?y(s,s):null,a=R(e.artifact),o=Kt(e.wait_ms??e.waitMs,Sr,0,mr),c=Kt(e.retry_interval_ms??e.retryIntervalMs,hr,1,Tr),E=Date.now();if(n.length===0)return{ok:!0,waited_ms:0,lock_free:!0};let _=s?_t(s):process.cwd(),l=n.map(A=>q(Wi(A)?_t(A):_t(_,A))),p=l.map(()=>"?").join(","),d=[],u=[];i&&(d.push("AND ai.workspace_path = ?"),u.push(i)),a&&(d.push("AND (ai.artifact = ? OR ai.artifact IS NULL)"),u.push(a));let g=t.prepare(`SELECT fl.file_path, ai.agent_id, fl.expires_at
     FROM locks fl
     JOIN task_runs ai ON ai.run_id = fl.run_id
     WHERE fl.file_path IN (${p})
       AND ai.agent_id <> ?
       AND ai.status = 'ACTIVE'
       ${d.join(`
       `)}
       AND (fl.expires_at IS NULL OR fl.expires_at > ?)`),h=new Int32Array(new SharedArrayBuffer(4)),f=()=>{we(t);let A=new Date().toISOString();return g.all(...l,r,...u,A)};function T(A){Atomics.wait(h,0,0,A)}let S=f(),m=()=>Date.now()-E;for(;S.length>0&&m()<o;)T(Math.min(c,o-m())),S=f();let L=m();return S.length===0?{ok:!0,waited_ms:L,lock_free:!0}:{ok:!0,waited_ms:L,lock_free:!1,conflicts:S.map(A=>({file_path:A.file_path,agent_id:A.agent_id,expires_at:A.expires_at}))}}import{randomUUID as qr}from"node:crypto";var zr=new Set(["SUCCESS","FAILED"]);function tn(t,e){let n=new Map(e.map(r=>[r,[]]));for(let r=0;r<e.length;r+=500){let s=e.slice(r,r+500),i=t.prepare(`SELECT run_id, file_path FROM run_files
       WHERE run_id IN (${s.map(()=>"?").join(",")})
       ORDER BY file_path`).all(...s);for(let a of i)n.get(a.run_id)?.push(a.file_path)}return n}function de(t,e,n){t.prepare("DELETE FROM locks WHERE run_id = ?").run(e),t.prepare(`UPDATE run_files SET heartbeat_at = ?, expires_at = ?, ended_at = ?
    WHERE run_id = ? AND ended_at IS NULL`).run(n,n,n,e)}function Et(t,e,n,r,s,i){let a=t.prepare("SELECT task_id FROM task_runs WHERE run_id = ?").get(e);if(!a?.task_id)return;let o=n==="SUCCESS"?"DONE":"FAILED";t.prepare(`UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?
    WHERE task_id = ? AND status = 'VERIFY'`).run(o,s,s,a.task_id).changes!==0&&t.prepare(`INSERT INTO task_events(event_id, task_id, run_id, agent_id, event_type, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`tevt_${qr().replace(/-/g,"")}`,a.task_id,e,r,n==="SUCCESS"?"VERIFIED":"VERIFICATION_FAILED",i??o,s)}function dt(t,e,n,r,s){let i=t.prepare("SELECT task_id FROM task_runs WHERE run_id = ?").get(e);!i?.task_id||t.prepare(`UPDATE tasks SET status = 'FAILED', updated_at = ?, completed_at = ?
    WHERE task_id = ? AND status IN ('IN_PROGRESS', 'VERIFY')`).run(r,r,i.task_id).changes===0||(t.prepare("DELETE FROM task_claims WHERE task_id = ?").run(i.task_id),t.prepare(`INSERT INTO task_events(event_id, task_id, run_id, agent_id, event_type, message, created_at)
    VALUES (?, ?, ?, ?, 'VERIFICATION_FAILED', ?, ?)`).run(`tevt_${qr().replace(/-/g,"")}`,i.task_id,e,n,s,r))}function $e(t,e={}){let n=e.workspacePath?y(e.workspacePath,e.workspacePath):null,r=["status = 'PENDING'"],s=[],i=null;if(e.olderThanDays!=null){if(!Number.isFinite(e.olderThanDays)||e.olderThanDays<1)throw new Error("olderThanDays must be a finite number >= 1");i=new Date(Date.now()-Math.floor(e.olderThanDays)*864e5).toISOString(),r.push("updated_at < ?"),s.push(i)}if(e.origins?.length){let u=[...new Set(e.origins)];if(u.some(g=>!["TASK","WORK","HOOK"].includes(g)))throw new Error("origins must contain only TASK, WORK, or HOOK");r.push(`origin IN (${u.map(()=>"?").join(",")})`),s.push(...u)}let a=null;if(e.minAgeMs!=null){if(!Number.isFinite(e.minAgeMs)||e.minAgeMs<0)throw new Error("minAgeMs must be a finite number >= 0");e.minAgeMs>0&&(a=new Date(Date.now()-Math.floor(e.minAgeMs)).toISOString(),r.push("created_at < ?"),s.push(a))}let o=null;if(e.before){let u=new Date(e.before);if(Number.isNaN(u.getTime()))throw new Error("before must be a valid ISO timestamp");o=u.toISOString(),r.push("created_at < ?"),s.push(o)}e.agentId&&(r.push("agent_id = ?"),s.push(e.agentId)),n&&(r.push("workspace_path = ?"),s.push(n));let c=R(e.artifact);c&&(r.push("(artifact = ? OR artifact IS NULL)"),s.push(c));let E=t.prepare(`SELECT run_id, agent_id, status, test_plan, context_ref, rationale, workspace_path, artifact, created_at
     FROM task_runs
     WHERE ${r.join(" AND ")}
     ORDER BY created_at ASC`).all(...s),_=tn(t,E.map(u=>u.run_id)),l=E.map(u=>({run_id:u.run_id,agent_id:u.agent_id,status:u.status,test_plan:u.test_plan,context_ref:u.context_ref,rationale:u.rationale,target_files:_.get(u.run_id)??[],workspace_path:u.workspace_path,artifact:u.artifact,created_at:u.created_at})),p=[];try{let u=I(),g=["ai.status = 'ACTIVE'","EXISTS (SELECT 1 FROM run_files any_rf WHERE any_rf.run_id = ai.run_id)",`NOT EXISTS (
        SELECT 1 FROM run_files active_rf
        WHERE active_rf.run_id = ai.run_id AND active_rf.ended_at IS NULL
          AND active_rf.expires_at > ?
      )`,`NOT EXISTS (
        SELECT 1 FROM task_claims tc
        WHERE tc.run_id = ai.run_id AND tc.expires_at > ?
      )`],h=[u,u];if(e.agentId&&(g.push("ai.agent_id = ?"),h.push(e.agentId)),n&&(g.push("ai.workspace_path = ?"),h.push(n)),c&&(g.push("(ai.artifact = ? OR ai.artifact IS NULL)"),h.push(c)),i&&(g.push("ai.updated_at < ?"),h.push(i)),e.origins?.length){let S=[...new Set(e.origins)];g.push(`ai.origin IN (${S.map(()=>"?").join(",")})`),h.push(...S)}a&&(g.push("ai.created_at < ?"),h.push(a)),o&&(g.push("ai.created_at < ?"),h.push(o));let f=t.prepare(`SELECT ai.run_id, ai.agent_id, ai.rationale, ai.context_ref, ai.workspace_path, ai.artifact, ai.created_at
       FROM task_runs ai
       WHERE ${g.join(" AND ")}
       ORDER BY ai.created_at ASC`).all(...h),T=tn(t,f.map(S=>S.run_id));for(let S of f){let m=Date.now()-new Date(S.created_at).getTime();p.push({run_id:S.run_id,agent_id:S.agent_id,status:"ACTIVE",rationale:S.rationale,context_ref:S.context_ref,target_files:T.get(S.run_id)??[],workspace_path:S.workspace_path,artifact:S.artifact,created_at:S.created_at,age_hours:Math.round(m/36e5*10)/10})}}catch(u){if(!(u instanceof Error&&u.message.includes("no such table")))throw u}let d=l.length+p.length;return{ok:!0,unverified:l,stale_active:p,count:d}}import{randomUUID as $i}from"node:crypto";import{existsSync as Bi}from"node:fs";import{isAbsolute as ji,resolve as Jr}from"node:path";var Zr=1,Qr=3650;function ke(t,e,n,r){let s=t[e]??t[n]??r,i=Number(s);if(!Number.isInteger(i)||i<Zr||i>Qr)throw new Error(`${e} must be an integer in ${Zr}..${Qr}`);return i}function nn(t,e={}){let n=Number(e.pressure_age_days??e.pressureAgeDays??1),r=Number.isFinite(n)?Math.min(3650,Math.max(1,Math.floor(n))):1,s=new Date(Date.now()-r*864e5).toISOString(),i=typeof e.workspace=="string"?e.workspace:typeof e.workspace_path=="string"?e.workspace_path:typeof e.workspacePath=="string"?e.workspacePath:null,a=i?e.workspace_normalized===!0?Jr(i):y(i,i):null,o=R(e.artifact),c=[],E=[];a&&(c.push("workspace_path = ?"),E.push(a)),o&&(c.push("artifact = ?"),E.push(o));let _=c.length>0?` AND ${c.join(" AND ")}`:"",l=t.prepare(`SELECT COUNT(*) AS count FROM task_runs
      WHERE status = 'PENDING' AND updated_at < ?${_}`).get(s,...E).count,p=t.prepare(`SELECT run_id FROM task_runs
      WHERE status = 'PENDING' AND updated_at < ?${_}
      ORDER BY datetime(updated_at), run_id LIMIT 3`).all(s,...E),d=$e(t,{workspacePath:a,artifact:o,olderThanDays:r}).stale_active,u=t.prepare(`SELECT COUNT(*) AS count FROM signals
      WHERE status = 'open' AND created_at < ?${_}`).get(s,...E).count,g=t.prepare(`SELECT signal_id FROM signals
      WHERE status = 'open' AND created_at < ?${_}
      ORDER BY datetime(created_at), signal_id LIMIT 3`).all(s,...E),h=t.prepare(`SELECT COUNT(*) AS count FROM signals
      WHERE kind = 'handoff' AND status = 'open' AND created_at < ?${_}`).get(s,...E).count,f=t.prepare(`SELECT signal_id FROM signals
      WHERE kind = 'handoff' AND status = 'open' AND created_at < ?${_}
      ORDER BY datetime(created_at), signal_id LIMIT 3`).all(s,...E),T=t.prepare(`SELECT m.memory_id, r.reference
       FROM memories m
       JOIN memory_refs r ON r.memory_id = m.memory_id
      WHERE m.state = 'ACTIVE'
        AND r.reference LIKE 'file:%'
        AND COALESCE(m.updated_at, m.created_at) < ?
        ${_.replaceAll("workspace_path","m.workspace_path").replaceAll("artifact","m.artifact")}
      ORDER BY datetime(COALESCE(m.updated_at, m.created_at)), m.memory_id
      LIMIT 1000`).all(s,...E),S=new Set;for(let m of T){let L=m.reference.slice(5).replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/,""),A=ji(L)?L:Jr(a??process.cwd(),L);Bi(A)||S.add(m.memory_id)}return{pressure_age_days:r,cutoff:s,stale_pending_runs:l,stale_active_runs:d.length,stale_open_signals:u,stale_handoff_signals:h,stale_missing_refs:S.size,samples:{run_ids:p.map(m=>m.run_id),active_run_ids:d.slice(0,3).map(m=>m.run_id),signal_ids:g.map(m=>m.signal_id),handoff_signal_ids:f.map(m=>m.signal_id),memory_ids:[...S].slice(0,3)}}}function Yi(t,e={}){let n=ke(e,"retention_days","retentionDays",90),r=ke(e,"refinement_handoff_retention_days","refinementHandoffRetentionDays",7),s=ke(e,"handoff_signal_retention_days","handoffSignalRetentionDays",1),i=ke(e,"refinement_done_retention_days","refinementDoneRetentionDays",30),a=ke(e,"operational_retention_days","operationalRetentionDays",90);ke(e,"pressure_age_days","pressureAgeDays",1);let o=e.fail_stale_active_runs??e.failStaleActiveRuns;if(o!=null&&typeof o!="boolean")throw new Error("fail_stale_active_runs must be boolean");let c=o!==!1,E=typeof e.workspace=="string"?e.workspace:typeof e.workspace_path=="string"?e.workspace_path:typeof e.workspacePath=="string"?e.workspacePath:null,_=E?y(E,E):null,l=R(e.artifact),p=new Date().toISOString(),d=new Date(Date.now()-n*864e5).toISOString(),u=new Date(Date.now()-r*864e5).toISOString(),g=new Date(Date.now()-s*864e5).toISOString(),h=new Date(Date.now()-i*864e5).toISOString(),f=new Date(Date.now()-a*864e5).toISOString(),T=nn(t,e),S={pressure_age_days:T.pressure_age_days,stale_pending_runs:T.stale_pending_runs,stale_active_runs:T.stale_active_runs,stale_open_signals:T.stale_open_signals,stale_handoff_signals:T.stale_handoff_signals,stale_missing_refs:T.stale_missing_refs,pressure_samples:T.samples},m=[],L=[];_&&(m.push("workspace_path = ?"),L.push(_)),l&&(m.push("artifact = ?"),L.push(l));let A=m.length>0?` AND ${m.join(" AND ")}`:"",w=[],v=[];_&&(w.push("workspace_path = ?"),v.push(_)),l&&(w.push("artifact = ?"),v.push(l));let X=w.length>0?` AND ${w.join(" AND ")}`:"";if(e.dry_run){let W=t.prepare(`SELECT COUNT(*) AS c FROM memories WHERE valid_to IS NOT NULL AND valid_to < ? AND state = 'ACTIVE'${A}`).get(p,...L).c,Z=t.prepare(`SELECT COUNT(*) AS c FROM memories WHERE state = 'SUPERSEDED' AND updated_at < ?${A}`).get(d,...L).c,x=ct(t,{..._?{workspace:_}:{},...l?{artifact:l}:{},expired_only:!0,dry_run:!0}),V=x.would_prune??0,ie=t.prepare(`SELECT COUNT(*) AS c FROM refinements
       WHERE ((quality = 'handoff' AND updated_at < ?)
          OR (quality IN ('good','bad') AND state = 'done' AND updated_at < ?))${X}`).get(u,h,...v).c,pe=t.prepare(`SELECT COUNT(*) AS c FROM signals WHERE kind = 'handoff' AND status = 'open' AND created_at < ?${A}`).get(g,...L).c,ne=$e(t,{workspacePath:_,artifact:l,olderThanDays:T.pressure_age_days}).stale_active.map(N=>N.run_id),ae=c?ne.length:0,Be=t.prepare(`SELECT COUNT(*) AS c FROM task_runs
      WHERE task_id IS NULL AND origin IN ('WORK','HOOK')
        AND status IN ('SUCCESS','FAILED') AND updated_at < ?${A}`).get(f,...L).c,C=t.prepare(`SELECT memory_id FROM memories
       WHERE valid_to IS NOT NULL AND valid_to < ? AND state = 'ACTIVE'${A}
       ORDER BY datetime(valid_to), memory_id LIMIT ?`).all(p,...L,20).map(N=>N.memory_id),fe=t.prepare(`SELECT memory_id FROM memories
       WHERE state = 'SUPERSEDED' AND updated_at < ?${A}
       ORDER BY datetime(updated_at), memory_id LIMIT ?`).all(d,...L,20).map(N=>N.memory_id),je=t.prepare(`SELECT refinement_id FROM refinements
       WHERE ((quality = 'handoff' AND updated_at < ?)
          OR (quality IN ('good','bad') AND state = 'done' AND updated_at < ?))${X}
       ORDER BY datetime(updated_at), refinement_id LIMIT ?`).all(u,h,...v,20).map(N=>N.refinement_id),ee=t.prepare(`SELECT run_id FROM task_runs
       WHERE task_id IS NULL AND origin IN ('WORK','HOOK')
         AND status IN ('SUCCESS','FAILED') AND updated_at < ?${A}
       ORDER BY datetime(updated_at), run_id LIMIT ?`).all(f,...L,20).map(N=>N.run_id);return{ok:!0,archived_memories:0,pruned_old:0,pruned_locks:0,pruned_refinements:0,resolved_handoff_signals:0,failed_stale_active_runs:0,pruned_runs:0,fts_rebuilt:!1,dry_run:!0,would_archive:W,would_prune_old:Z,would_prune_locks:V,would_prune_refinements:ie,would_resolve_handoff_signals:pe,would_fail_stale_active_runs:ae,would_prune_runs:Be,candidate_limit:20,candidate_ids:{expire_memory_ids:C,purge_memory_ids:fe,locks:x.locks??[],refinement_ids:je,run_ids:ee,stale_active_run_ids:ne.slice(0,20)},...S}}let k={changes:0},D={changes:0},U=0,M={changes:0},B=0,H=0,G={changes:0},z=!1,J=!t.isTransaction;J&&t.exec("BEGIN IMMEDIATE");try{if(k=t.prepare(`UPDATE memories
       SET state = 'SUPERSEDED', expired_at = ?, updated_at = ?
       WHERE valid_to IS NOT NULL AND valid_to < ? AND state = 'ACTIVE'${A}`).run(p,p,p,...L),D=t.prepare(`DELETE FROM memories
       WHERE state = 'SUPERSEDED' AND updated_at < ?${A}`).run(d,...L),U=ct(t,{..._?{workspace:_}:{},...l?{artifact:l}:{},expired_only:!0}).pruned_locks,M=t.prepare(`DELETE FROM refinements
       WHERE ((quality = 'handoff' AND updated_at < ?)
          OR (quality IN ('good','bad') AND state = 'done' AND updated_at < ?))${X}`).run(u,h,...v),B=t.prepare(`UPDATE signals SET status = 'resolved', resolved_at = ?
       WHERE kind = 'handoff' AND status = 'open' AND created_at < ?${A}`).run(p,g,...L).changes,c){let b=$e(t,{workspacePath:_,artifact:l,olderThanDays:T.pressure_age_days}).stale_active;for(let W of b){if(t.prepare(lt).run(p,W.run_id).changes!==1)continue;de(t,W.run_id,p);let x=`maintenance digest: stale ACTIVE run had no live file presence after ${T.pressure_age_days}d`;dt(t,W.run_id,W.agent_id,p,x);try{t.prepare(_e).run("evt_"+$i().replace(/-/g,""),W.run_id,W.agent_id,x,p)}catch{}H+=1}}G=t.prepare(`DELETE FROM task_runs
      WHERE task_id IS NULL AND origin IN ('WORK','HOOK')
        AND status IN ('SUCCESS','FAILED') AND updated_at < ?${A}`).run(f,...L),Y(t)&&(ye(t),z=!0),J&&t.exec("COMMIT")}catch(b){if(J)try{t.exec("ROLLBACK")}catch{}throw b}J&&qe(t);let $=nn(t,e),Q={pressure_age_days:$.pressure_age_days,stale_pending_runs:$.stale_pending_runs,stale_active_runs:$.stale_active_runs,stale_open_signals:$.stale_open_signals,stale_handoff_signals:$.stale_handoff_signals,stale_missing_refs:$.stale_missing_refs,pressure_samples:$.samples};return{ok:!0,archived_memories:k.changes,pruned_old:D.changes,pruned_locks:U,pruned_refinements:M.changes,resolved_handoff_signals:B,failed_stale_active_runs:H,pruned_runs:G.changes,fts_rebuilt:z,...Q}}function Gi(t,e={}){let n=e.workspace_path??null,r=n?y(n,n):null,s=R(e.artifact),i=["state = 'ACTIVE'"],a=[];r&&(i.push("(workspace_path = ? OR workspace_path IS NULL)"),a.push(r)),s&&(i.push("(artifact = ? OR artifact IS NULL)"),a.push(s));let o=t.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${i.join(" AND ")}`).get(...a).c,c=[],E=[];r&&(c.push("workspace_path = ?"),E.push(r)),s&&(c.push("(artifact = ? OR artifact IS NULL)"),E.push(s));let _=c.length>0?` AND ${c.join(" AND ")}`:"",l=t.prepare(`SELECT COUNT(*) AS c FROM task_runs WHERE status = 'PENDING'${_}`).get(...E).c,p=t.prepare(`SELECT COUNT(*) AS c FROM task_runs WHERE status = 'ACTIVE'${_}`).get(...E).c,d=[],u=[];r&&(d.push("p.workspace_path = ?"),u.push(r)),s&&(d.push("(p.artifact = ? OR p.artifact IS NULL)"),u.push(s));let g=d.length>0?` AND ${d.join(" AND ")}`:"",h=t.prepare(`SELECT COUNT(*) AS c FROM plans p WHERE p.status IN ('DRAFT','ACTIVE','PAUSED')${g}`).get(...u).c,f=t.prepare(`SELECT COUNT(*) AS c FROM tasks t JOIN plans p ON p.plan_id = t.plan_id
    WHERE t.status = 'OPEN'${g}
      AND NOT EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.task_id AND c.expires_at > ?)
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td JOIN tasks dependency ON dependency.task_id = td.depends_on_task_id
        WHERE td.task_id = t.task_id AND dependency.status <> 'DONE'
      )`).get(...u,I()).c,T=t.prepare(`SELECT COUNT(*) AS c FROM tasks t JOIN plans p ON p.plan_id = t.plan_id WHERE t.status = 'IN_PROGRESS'${g}`).get(...u).c,S=t.prepare(`SELECT COUNT(*) AS c FROM tasks t JOIN plans p ON p.plan_id = t.plan_id WHERE t.status = 'VERIFY'${g}`).get(...u).c,m=ve(t,{workspacePath:r,artifact:s,repo:e.repo,cwd:e.cwd}),L=ve(t,{workspacePath:r,artifact:s,repo:e.repo,cwd:e.cwd,includeHandoffs:!0}),A=["(fl.expires_at IS NULL OR fl.expires_at > ?)","ai.status = 'ACTIVE'"],w=[I()];r&&(A.push("ai.workspace_path = ?"),w.push(r)),s&&(A.push("(ai.artifact = ? OR ai.artifact IS NULL)"),w.push(s));let v=A.length>0?`WHERE ${A.join(" AND ")}`:"",X=t.prepare(`SELECT COUNT(*) AS count
     FROM locks fl
     JOIN task_runs ai ON ai.run_id = fl.run_id
     ${v}`).get(...w).count,D=t.prepare(`SELECT fl.file_path, ai.agent_id, fl.run_id, ai.rationale AS reason, fl.expires_at
     FROM locks fl
     JOIN task_runs ai ON ai.run_id = fl.run_id
     ${v}
     ORDER BY fl.acquired_at DESC
     LIMIT 50`).all(...w).map(U=>it({filePath:U.file_path,agentId:U.agent_id,runId:U.run_id,reason:U.reason,expiresAt:U.expires_at}));return{ok:!0,active_memories:o,pending_runs:l,active_runs:p,active_plans:h,ready_tasks:f,in_progress_tasks:T,verify_tasks:S,actionable_refinements:m,all_open_refinements:L,lock_count:X,locks:D}}function Vi(t,e={}){let n=e.workspace_path??null,r=n?y(n,n):null,s=R(e.artifact),i=new Date().toISOString().slice(0,10),a=["m.state = 'ACTIVE'"],o=[];r&&(a.push("(m.workspace_path = ? OR m.workspace_path IS NULL)"),o.push(r)),s&&(a.push("(m.artifact = ? OR m.artifact IS NULL)"),o.push(s));let c=t.prepare(`SELECT m.memory_id, m.label, m.importance, m.task_context, m.observation,
            m.tags_json, m.repo, m.ref, m.failure_signature, m.created_at
     FROM memories m
     WHERE ${a.join(" AND ")}
     ORDER BY m.importance DESC, m.created_at DESC`).all(...o);if(c.length>0){let l=t.prepare(`SELECT r.memory_id, r.reference
       FROM memory_refs r
       JOIN memories m ON m.memory_id = r.memory_id
       WHERE ${a.join(" AND ")}
       ORDER BY r.memory_id, r.ordinal`).all(...o),p=new Map;for(let d of l){let u=p.get(d.memory_id)??[];u.push(d.reference),p.set(d.memory_id,u)}for(let d of c)d.references=p.get(d.memory_id)??[]}let E={};for(let l of c){let p=l.label??"OTHER";(E[p]??=[]).push(l)}let _=[`# Memory Store Report \u2014 ${i}`,"",`**Total active memories:** ${c.length}`,`**By label:** ${Object.entries(E).map(([l,p])=>`${l}(${p.length})`).join(", ")}`,""];for(let[l,p]of Object.entries(E)){_.push(`## ${l}`,"");for(let d of p){let u=j(d.tags_json);_.push(`### \`${d.memory_id}\` \u2014 importance ${d.importance}`,`**Context:** ${d.task_context}`,`**Observation:** ${d.observation}`),u.length&&_.push(`**Tags:** ${u.join(", ")}`),d.references.length&&_.push(`**References:** ${d.references.join(", ")}`),d.failure_signature&&_.push(`**Failure signature:** ${d.failure_signature}`),d.repo&&_.push(`**Repo:** ${d.repo}${d.ref?` @ ${d.ref}`:""}`),_.push(`**Created:** ${d.created_at.slice(0,10)}`,"")}}return _.join(`
`)}function Ki(t,e={}){let n=Number(e.limit??10),r=Number(e.min_importance??e.minImportance??7),s=e.workspace_path??null,i=s?y(s,s):null,a=R(e.artifact),o=!!(e.harness_only??e.harnessOnly??!1),c=[],E=[];i&&(c.push("(workspace_path = ? OR workspace_path IS NULL)"),E.push(i)),a&&(c.push("(artifact = ? OR artifact IS NULL)"),E.push(a));let _=c.length>0?`AND ${c.join(" AND ")}`:"",l=t.prepare(`SELECT memory_id, label, importance, observation
     FROM memories
     WHERE state = 'ACTIVE'
       AND tags_json LIKE '%"harness"%'
       ${_}
     ORDER BY importance DESC, access_count DESC
     LIMIT ?`).all(...E,n),p=[];for(let f of l)p.push({memory_id:f.memory_id,label:f.label,importance:f.importance,observation:f.observation,tier:"harness"});if(!o&&p.length<n){let f=new Set(p.map(m=>m.memory_id)),T=n-p.length,S=t.prepare(`SELECT memory_id, label, importance, observation
       FROM memories
       WHERE state = 'ACTIVE'
         AND importance >= ?
         AND label <> 'EXPERIENCE'
         AND tags_json NOT LIKE '%"harness"%'
         ${_}
       ORDER BY importance DESC, access_count DESC, last_accessed_at DESC
       LIMIT ?`).all(r,...E,T*2);for(let m of S)!f.has(m.memory_id)&&p.length<n&&p.push({memory_id:m.memory_id,label:m.label,importance:m.importance,observation:m.observation,tier:"general"})}if(p.length===0)return{count:0,harness_count:0,markdown:"<!-- No harness or high-importance memories to export -->",memories:[],next:'No harness proposals yet. Use octocode-awareness reflect record --fix-harness "<proposal>" after evidence shows a reusable harness gap.'};let d=p.filter(f=>f.tier==="harness").length,u=["## Agent lessons (generated by octocode-awareness \xB7 reflect export-harness)","","<!-- Tier 1: harness proposals from reflect record --fix-harness: -->",""],g=p.filter(f=>f.tier==="harness"),h=p.filter(f=>f.tier==="general");for(let f of g)u.push(`- **[HARNESS:${f.importance}]** ${f.observation}`);if(h.length>0){u.push("","<!-- Tier 2: high-importance general lessons -->","");for(let f of h)u.push(`- **[${f.label}:${f.importance}]** ${f.observation}`)}return u.push(""),{count:p.length,harness_count:d,markdown:u.join(`
`),memories:p,next:"Human review required: apply approved guidance to its owning AGENTS.md, SKILL.md, or doc; run that surface's verification and skill review; then record the outcome with octocode-awareness reflect record."}}import{randomUUID as pt}from"node:crypto";function qi(t,e){let{agentId:n="agent",allPending:r=!1,message:s,adoptVerification:i=!1}=e,a=e.workspacePath?y(e.workspacePath,e.workspacePath):null,o=R(e.artifact),c=e.runId??"",E=e.status??"SUCCESS";if(!zr.has(E))return{ok:!1,error:`invalid status "${E}" \u2014 must be SUCCESS or FAILED`,run_id:c||null};let _=s?.trim()??"";if(E==="SUCCESS"&&!_)return{ok:!1,error:"SUCCESS verification requires a non-empty evidence receipt in message",run_id:c||null};if(r&&!a&&!o)return{ok:!1,error:"--all-pending requires --workspace or --artifact; use explicit run ids for cross-workspace verification",run_id:null};if(i&&(r||!a))return{ok:!1,error:"--adopt-verification requires one explicit --run-id and --workspace",run_id:c||null};if(r){let p=[a?" AND workspace_path = ?":"",o?" AND (artifact = ? OR artifact IS NULL)":""].join(""),d=Nr.replace("{DYNAMIC_WHERE}",p),u=[n];a&&u.push(a),o&&u.push(o),t.exec("BEGIN IMMEDIATE");try{let g=t.prepare(d).all(...u),h=I(),f=[];for(let T of g)if(t.prepare(qt).run(E,h,T.run_id,n).changes!==0&&(de(t,T.run_id,h),Et(t,T.run_id,E,n,h,_||void 0),f.push(T.run_id),_))try{t.prepare(_e).run("evt_"+pt().replace(/-/g,""),T.run_id,n,_,h)}catch{}return t.exec("COMMIT"),{ok:!0,run_id:null,run_ids:f,count:f.length,status:E,updated_at:h}}catch(g){try{t.exec("ROLLBACK")}catch{}throw g}}if(!c)return{ok:!1,error:"--run-id is required (or use --all-pending)",run_id:null};let l=I();t.exec("BEGIN IMMEDIATE");try{if(t.prepare(qt).run(E,l,c,n).changes===0){let d=t.prepare(Ir).get(c);if(!d)return t.exec("ROLLBACK"),{ok:!1,error:`no run found with run_id=${c}`,run_id:c};if(d.agent_id!==n){if(!i)return t.exec("ROLLBACK"),{ok:!1,error:`run ${c} belongs to agent "${d.agent_id}", not "${n}"; pass --agent-id ${d.agent_id} or explicit --adopt-verification with --workspace after verifying the check`,run_id:c};if(!a||d.workspace_path!==a||d.status!=="PENDING")return t.exec("ROLLBACK"),{ok:!1,error:`run ${c} cannot be verification-adopted outside its workspace or non-PENDING state`,run_id:c};if(t.prepare(Rr).run(E,l,c,a).changes!==1)return t.exec("ROLLBACK"),{ok:!1,error:`run ${c} changed while verification adoption was being recorded`,run_id:c};let g=`verification adopted by ${n} from ${d.agent_id}: ${_}`;de(t,c,l),Et(t,c,E,d.agent_id,l,g);try{t.prepare(_e).run("evt_"+pt().replace(/-/g,""),c,n,g,l)}catch{}return t.exec("COMMIT"),{ok:!0,run_id:c,status:E,updated_at:l}}if(d.status==="ACTIVE"&&E==="FAILED"){if(!_)return t.exec("ROLLBACK"),{ok:!1,error:"failing a stale ACTIVE run requires a non-empty evidence receipt in message",run_id:c};let u=t.prepare(`SELECT
          EXISTS(SELECT 1 FROM run_files WHERE run_id = ?) AS has_files,
          EXISTS(SELECT 1 FROM run_files WHERE run_id = ? AND ended_at IS NULL AND expires_at > ?) AS live_files,
          EXISTS(SELECT 1 FROM task_claims WHERE run_id = ? AND expires_at > ?) AS live_claim`).get(c,c,l,c,l);if(!u.has_files||u.live_files||u.live_claim)return t.exec("ROLLBACK"),{ok:!1,error:`run ${c} is ACTIVE and still live \u2014 only stale ACTIVE runs with expired file presence and claim can be marked FAILED`,run_id:c};if(t.prepare(lt).run(l,c).changes!==1)return t.exec("ROLLBACK"),{ok:!1,error:`run ${c} changed while stale failure was being recorded`,run_id:c};de(t,c,l),dt(t,c,n,l,_);try{t.prepare(_e).run("evt_"+pt().replace(/-/g,""),c,n,_,l)}catch{}return t.exec("COMMIT"),{ok:!0,run_id:c,status:"FAILED",updated_at:l}}return t.exec("ROLLBACK"),{ok:!1,error:`run ${c} has status "${d.status}" \u2014 only PENDING runs can be verified`,run_id:c}}if(_)try{t.prepare(_e).run("evt_"+pt().replace(/-/g,""),c,n,_,l)}catch{}return de(t,c,l),Et(t,c,E,n,l,_||void 0),t.exec("COMMIT"),{ok:!0,run_id:c,status:E,updated_at:l}}catch(p){try{t.exec("ROLLBACK")}catch{}throw p}}function s_(t,e){let n=e.agentId,r=e.agentName??"",s=e.workspacePath?y(e.workspacePath,e.workspacePath):null,i=R(e.artifact),a=e.context??null,o=I();return t.prepare(Cr).run(n,r,s,i,a,o,o),{agent_id:n,agent_name:r,workspace_path:s,artifact:i,context:a,registered_at:o,last_seen_at:o}}function i_(t,e,n=null,r=null){try{let s=n?y(n,n):null;t.prepare(xr).run(I(),s,R(r),e)}catch{}}function a_(t,e){try{let r=t.prepare(Mr).get(e)?.agent_name??"";return r!==""?r:null}catch{return null}}function o_(t,e){let n=new Map;if(e.length===0)return n;try{let r=e.map(()=>"?").join(","),s=t.prepare(`${Fr}(${r}) ${Pr}`).all(...e);for(let i of s)n.set(i.agent_id,i.agent_name)}catch{}return n}function c_(t,e={}){try{let n=[],r=Ur,s=[];e.workspacePath&&(s.push(br),n.push(y(e.workspacePath,e.workspacePath)??e.workspacePath));let i=R(e.artifact);i&&(s.push(vr),n.push(i)),s.length>0&&(r+=` WHERE ${s.join(" AND ")}`),r+=` ${Wr}`;let a=t.prepare(r).all(...n);return{count:a.length,agents:a}}catch{return{count:0,agents:[]}}}export{an as a,es as b,Ji as c,I as d,j as e,Zi as f,on as g,ge as h,me as i,cn as j,ts as k,ln as l,sn as m,Qi as n,un as o,R as p,Ge as q,Ye as r,ea as s,Ts as t,Y as u,pn as v,Tt as w,we as x,as as y,te as z,qe as A,De as B,Rn as C,fs as D,Ln as E,gs as F,Rt as G,Lt as H,ks as I,q as J,F as K,y as L,Le as M,Ze as N,xt as O,Ut as P,Bn as Q,Ps as R,bt as S,Us as T,bs as U,vs as V,Xs as W,$s as X,ko as Y,Bs as Z,js as _,Ys as $,rl as aa,al as ba,Vs as ca,Go as da,nr as ea,Vo as fa,Ko as ga,rt as ha,be as ia,ir as ja,Qs as ka,tc as la,nc as ma,ei as na,rc as oa,uc as pa,or as qa,_c as ra,si as sa,Ec as ta,ue as ua,oi as va,li as wa,_r as xa,ui as ya,_i as za,Ei as Aa,di as Ba,fi as Ca,gi as Da,mi as Ea,Ti as Fa,Bc as Ga,jc as Ha,Yc as Ia,Gc as Ja,Vc as Ka,ct as La,We as Ma,Oi as Na,ki as Oa,Xe as Pa,Zt as Qa,bi as Ra,Xi as Sa,Hi as Ta,$e as Ua,nn as Va,Yi as Wa,Gi as Xa,Vi as Ya,Ki as Za,qi as _a,s_ as $a,i_ as ab,a_ as bb,o_ as cb,c_ as db};
