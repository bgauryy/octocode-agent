// src/sql/audit.ts — SQL constants for edit_log and harness_log tables

// ─── edit_log ─────────────────────────────────────────────────────────────────

export const EDIT_LOG_INSERT = `
  INSERT INTO edit_log (
    edit_id, session_id, run_id, agent_id,
    file_path, operation, old_file_path,
    lines_added, lines_removed, content_hash,
    workspace_path, artifact, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const EDIT_LOG_SELECT_ALL = `
  SELECT * FROM edit_log ORDER BY created_at DESC
`;

export const EDIT_LOG_SELECT_BY_SESSION = `
  SELECT * FROM edit_log WHERE session_id = ? ORDER BY created_at DESC
`;

export const EDIT_LOG_SELECT_BY_RUN = `
  SELECT * FROM edit_log WHERE run_id = ? ORDER BY created_at DESC
`;

export const EDIT_LOG_SELECT_BY_AGENT = `
  SELECT * FROM edit_log WHERE agent_id = ? ORDER BY created_at DESC
`;

export const EDIT_LOG_SELECT_BY_FILE = `
  SELECT * FROM edit_log WHERE file_path = ? ORDER BY created_at DESC
`;

export const EDIT_LOG_SELECT_BY_WORKSPACE = `
  SELECT * FROM edit_log WHERE workspace_path = ? ORDER BY created_at DESC
`;

export const EDIT_LOG_SELECT_BY_OPERATION = `
  SELECT * FROM edit_log WHERE operation = ? ORDER BY created_at DESC
`;

export const EDIT_LOG_SELECT_SINCE = `
  SELECT * FROM edit_log WHERE created_at >= ? ORDER BY created_at DESC
`;

// ─── harness_log ──────────────────────────────────────────────────────────────

export const HARNESS_LOG_INSERT = `
  INSERT INTO harness_log (
    harness_id, session_id, agent_id, workspace_path, artifact, event_type,
    payload_json, memory_id, run_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const HARNESS_LOG_SELECT_ALL = `
  SELECT * FROM harness_log ORDER BY created_at DESC
`;

export const HARNESS_LOG_SELECT_BY_SESSION = `
  SELECT * FROM harness_log WHERE session_id = ? ORDER BY created_at DESC
`;

export const HARNESS_LOG_SELECT_BY_AGENT = `
  SELECT * FROM harness_log WHERE agent_id = ? ORDER BY created_at DESC
`;

export const HARNESS_LOG_SELECT_BY_EVENT = `
  SELECT * FROM harness_log WHERE event_type = ? ORDER BY created_at DESC
`;

export const HARNESS_LOG_SELECT_BY_MEMORY = `
  SELECT * FROM harness_log WHERE memory_id = ? ORDER BY created_at DESC
`;

export const HARNESS_LOG_SELECT_BY_RUN = `
  SELECT * FROM harness_log WHERE run_id = ? ORDER BY created_at DESC
`;
