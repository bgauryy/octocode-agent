import { LitePlanGraph } from './lite-plan-graph.js';

export abstract class LiteMigration extends LitePlanGraph {
  protected migrate(): void {
    // Every coordination table carries `workspace_path` so a single global store
    // (~/.octocode/octocode.sqlite3) isolates repos by column rather than by
    // file. locks/work_presence fold it into their composite primary keys; the
    // rest scope through indexes + `WHERE workspace_path = ?` on every query.
    // Tables first — no indexes here. A legacy table that predates
    // `workspace_path` is left untouched by CREATE TABLE IF NOT EXISTS, so any
    // index over that column must wait until the backfill below runs; creating
    // tables and indexes in one exec would reference a not-yet-added column.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'DONE', 'ABANDONED')),
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
        check_command TEXT,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLAIMED', 'DONE', 'CANCELLED')),
        priority INTEGER NOT NULL DEFAULT 0,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        source_step_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        done_at TEXT,
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
    `);
    // Legacy per-repo files predate workspace_path — backfill the column so a
    // pre-existing store keeps opening. Fresh tables already declare it NOT NULL.
    for (const table of ['plans', 'tasks', 'locks', 'work_presence', 'handoffs', 'memories', 'agents', 'messages']) {
      this.addColumnIfMissing(table, 'workspace_path', "TEXT NOT NULL DEFAULT ''");
    }
    // Add all backward-compat columns before index creation and constraint upgrade.
    // (CREATE TABLE IF NOT EXISTS is a no-op on old DBs; addColumnIfMissing handles each gap.)
    this.addColumnIfMissing('tasks', 'paths_json', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('tasks', 'reasoning', 'TEXT');
    this.addColumnIfMissing('tasks', 'acceptance', 'TEXT');
    this.addColumnIfMissing('tasks', 'check_command', 'TEXT');
    this.addColumnIfMissing('tasks', 'priority', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('tasks', 'dependencies_json', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('tasks', 'claimed_at', 'TEXT');
    this.addColumnIfMissing('tasks', 'lease_expires_at', 'TEXT');
    this.addColumnIfMissing('tasks', 'verified_at', 'TEXT');
    this.addColumnIfMissing('tasks', 'verified_by', 'TEXT');
    this.addColumnIfMissing('tasks', 'verification_message', 'TEXT');
    // Phase 1: source identity columns for plans and tasks.
    this.addColumnIfMissing('plans', 'source_kind', 'TEXT');
    this.addColumnIfMissing('plans', 'source_key', 'TEXT');
    this.addColumnIfMissing('plans', 'rfc_path', 'TEXT');
    this.addColumnIfMissing('plans', 'rfc_revision', 'TEXT');
    this.addColumnIfMissing('tasks', 'source_step_key', 'TEXT');
    // Upgrade status constraints on old tables (ABANDONED/CANCELLED) before index creation.
    // All columns exist at this point so the rebuild SELECT succeeds.
    this.upgradeStatusConstraints();
    // Indexes after constraint upgrade and column additions so they always reference current columns.
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
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_unverified ON tasks(status, verified_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at)');
    // Partial unique indexes for idempotent materialization.
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_source ON plans(workspace_path, source_kind, source_key) WHERE source_kind IS NOT NULL AND source_key IS NOT NULL');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_step ON tasks(plan_id, source_step_key) WHERE source_step_key IS NOT NULL');
    // Optional semantic-memory columns (host-owned embedder via OCTOCODE_EMBED_CMD).
    this.addColumnIfMissing('memories', 'embedding', 'BLOB');
    this.addColumnIfMissing('memories', 'embedding_model', 'TEXT');
  }

  protected upgradeStatusConstraints(): void {
    // Detect old plans table (missing ABANDONED status) and rebuild if needed.
    const plansDDL = (this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plans'",
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (!plansDDL.includes('ABANDONED')) {
      this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.db.exec(`
          CREATE TABLE plans_v2 (
            plan_id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            goal TEXT,
            status TEXT NOT NULL CHECK(status IN ('OPEN', 'DONE', 'ABANDONED')),
            source_kind TEXT,
            source_key TEXT,
            rfc_path TEXT,
            rfc_revision TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO plans_v2(plan_id, workspace_path, title, goal, status, source_kind, source_key, rfc_path, rfc_revision, created_at, updated_at)
            SELECT plan_id, workspace_path, title, goal, status, source_kind, source_key, rfc_path, rfc_revision, created_at, updated_at FROM plans;
          DROP TABLE plans;
          ALTER TABLE plans_v2 RENAME TO plans;
        `);
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON');
      }
    }
    // Detect old tasks table (missing CANCELLED status) and rebuild if needed.
    const tasksDDL = (this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (!tasksDDL.includes('CANCELLED')) {
      this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.db.exec(`
          CREATE TABLE tasks_v2 (
            task_id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL DEFAULT '',
            plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            file_path TEXT,
            paths_json TEXT NOT NULL DEFAULT '[]',
            reasoning TEXT,
            acceptance TEXT,
            check_command TEXT,
            status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLAIMED', 'DONE', 'CANCELLED')),
            priority INTEGER NOT NULL DEFAULT 0,
            dependencies_json TEXT NOT NULL DEFAULT '[]',
            agent_id TEXT,
            claimed_at TEXT,
            lease_expires_at TEXT,
            source_step_key TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            done_at TEXT,
            verified_at TEXT,
            verified_by TEXT,
            verification_message TEXT
          );
          INSERT INTO tasks_v2(task_id, workspace_path, plan_id, title, file_path, paths_json, reasoning, acceptance, check_command, status, priority, dependencies_json, agent_id, claimed_at, lease_expires_at, source_step_key, created_at, updated_at, done_at, verified_at, verified_by, verification_message)
            SELECT task_id, workspace_path, plan_id, title, file_path, COALESCE(paths_json, '[]'), reasoning, acceptance, check_command, status, COALESCE(priority, 0), COALESCE(dependencies_json, '[]'), agent_id, claimed_at, lease_expires_at, source_step_key, created_at, updated_at, done_at, verified_at, verified_by, verification_message FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_v2 RENAME TO tasks;
        `);
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  protected addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
