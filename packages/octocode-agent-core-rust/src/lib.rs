use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROTOCOL_VERSION: i64 = 1;
pub const MAX_PROTOCOL_FRAME_BYTES: usize = 1024 * 1024;
const MIN_SESSION_PAGE_RESULT_BYTES: usize = 128;
const MAX_SESSION_PAGE_RESULT_BYTES: usize = MAX_PROTOCOL_FRAME_BYTES - 1024;
const DATABASE_SCHEMA_VERSION: i64 = 6;
const TERMINAL_EFFECT_STATES: [&str; 4] = ["committed", "failed", "cancelled", "uncertain"];

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Ok {
        #[serde(rename = "schemaVersion")]
        schema_version: i64,
        id: Value,
        ok: bool,
        result: Value,
    },
    Err {
        #[serde(rename = "schemaVersion")]
        schema_version: i64,
        id: Value,
        ok: bool,
        error: ErrorBody,
    },
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug)]
pub struct ActorError {
    code: &'static str,
    message: String,
}

impl ActorError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: "CONFLICT",
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: "NOT_FOUND",
            message: message.into(),
        }
    }

    fn internal() -> Self {
        Self {
            code: "INTERNAL",
            message: "Storage operation failed".into(),
        }
    }

    fn frame_too_large(message: impl Into<String>) -> Self {
        Self {
            code: "FRAME_TOO_LARGE",
            message: message.into(),
        }
    }
}

type ActorResult<T> = Result<T, ActorError>;
type AutomationDefinitionRecord = (
    i64,
    String,
    String,
    String,
    i64,
    i64,
    String,
    i64,
    String,
    i64,
    i64,
);

fn required_str<'a>(params: &'a Value, key: &str) -> ActorResult<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ActorError::invalid(format!("{key} must be a non-empty string")))
}

fn required_i64(params: &Value, key: &str) -> ActorResult<i64> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| ActorError::invalid(format!("{key} must be an integer")))
}

fn required_non_negative_i64(params: &Value, key: &str) -> ActorResult<i64> {
    let value = required_i64(params, key)?;
    if value < 0 {
        return Err(ActorError::invalid(format!("{key} must be non-negative")));
    }
    Ok(value)
}

fn validate_schedule(schedule: &Value) -> ActorResult<()> {
    let kind = required_str(schedule, "kind")?;
    match kind {
        "once" => {
            reject_unknown_keys(schedule, &["kind", "at"])?;
            required_non_negative_i64(schedule, "at")?;
        }
        "interval" => {
            reject_unknown_keys(schedule, &["kind", "everyMs", "anchorAt"])?;
            let every_ms = required_i64(schedule, "everyMs")?;
            if every_ms <= 0 {
                return Err(ActorError::invalid("schedule.everyMs must be positive"));
            }
            required_non_negative_i64(schedule, "anchorAt")?;
        }
        "cron" => {
            reject_unknown_keys(schedule, &["kind", "expression", "timeZone"])?;
            required_str(schedule, "expression")?;
            required_str(schedule, "timeZone")?;
        }
        _ => return Err(ActorError::invalid("schedule.kind is invalid")),
    }
    Ok(())
}

fn reject_unknown_keys(input: &Value, allowed: &[&str]) -> ActorResult<()> {
    let object = input
        .as_object()
        .ok_or_else(|| ActorError::invalid("params must be an object"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(ActorError::invalid(format!("Unknown parameter: {key}")));
    }
    Ok(())
}

fn required_revision(params: &Value, key: &str) -> ActorResult<i64> {
    let value = required_str(params, key)?;
    let canonical = value == "0"
        || (!value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit()));
    if !canonical {
        return Err(ActorError::invalid(format!(
            "{key} must be a canonical non-negative decimal string within i64 range"
        )));
    }
    value.parse::<i64>().map_err(|_| {
        ActorError::invalid(format!(
            "{key} must be a canonical non-negative decimal string within i64 range"
        ))
    })
}

fn db<T>(result: rusqlite::Result<T>) -> ActorResult<T> {
    result.map_err(|_| ActorError::internal())
}

fn db_with_startup_retry<T>(mut operation: impl FnMut() -> rusqlite::Result<T>) -> ActorResult<T> {
    for attempt in 0..20 {
        match operation() {
            Ok(value) => return Ok(value),
            Err(rusqlite::Error::SqliteFailure(detail, _))
                if (detail.extended_code == rusqlite::ffi::SQLITE_BUSY
                    || detail.extended_code == rusqlite::ffi::SQLITE_LOCKED)
                    && attempt < 19 =>
            {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err(ActorError::internal()),
        }
    }
    Err(ActorError::internal())
}

fn now_ms() -> ActorResult<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ActorError::internal())?
        .as_millis();
    i64::try_from(millis).map_err(|_| ActorError::internal())
}

fn session_index_metadata(event: &Value) -> (Option<String>, Option<String>, Option<i64>) {
    let updated_at = event
        .get("timestamp")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0);
    let stored = event.get("event");
    let kind = stored
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str);
    let value = stored
        .and_then(|value| value.get("value"))
        .and_then(Value::as_str);
    let cwd = (stored
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        == Some("custom.appended")
        && kind == Some("session.cwd"))
    .then(|| value.map(str::to_owned))
    .flatten();
    let parent = (stored
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        == Some("custom.appended")
        && kind == Some("session.parent"))
    .then(|| {
        value
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
    })
    .flatten();
    (cwd, parent, updated_at)
}

#[cfg(unix)]
fn harden_database_permissions(path: &Path) -> ActorResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| ActorError::internal())
}

#[cfg(not(unix))]
fn harden_database_permissions(_path: &Path) -> ActorResult<()> {
    Ok(())
}

fn database_version(connection: &Connection) -> ActorResult<i64> {
    db(connection.pragma_query_value(None, "user_version", |row| row.get(0)))
}

fn migrate_one(connection: &mut Connection, expected: i64) -> ActorResult<i64> {
    let transaction = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let current: i64 = db(transaction.pragma_query_value(None, "user_version", |row| row.get(0)))?;
    if current != expected {
        db(transaction.commit())?;
        return Ok(current);
    }
    let next = match current {
        1 => {
            db(transaction.execute(
                "ALTER TABLE effects ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
                [],
            ))?;
            2
        }
        2 => {
            db(transaction.execute("ALTER TABLE sessions ADD COLUMN cwd TEXT", []))?;
            db(transaction.execute("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT", []))?;
            db(transaction.execute(
                "ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)",
                [],
            ))?;
            let rows: Vec<(String, String)> = {
                let mut statement = db(transaction.prepare(
                    "SELECT session_id, event_json FROM session_events ORDER BY session_id, sequence",
                ))?;
                let mapped = db(statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))))?;
                let mut rows = Vec::new();
                for row in mapped {
                    rows.push(db(row)?);
                }
                rows
            };
            let mut metadata: HashMap<String, (Option<String>, Option<String>, i64)> =
                HashMap::new();
            for (session_id, encoded) in rows {
                let event: Value =
                    serde_json::from_str(&encoded).map_err(|_| ActorError::internal())?;
                let (cwd, parent, updated_at) = session_index_metadata(&event);
                let entry = metadata.entry(session_id).or_insert((None, None, 0));
                if cwd.is_some() {
                    entry.0 = cwd;
                }
                if parent.is_some() {
                    entry.1 = parent;
                }
                if let Some(updated_at) = updated_at {
                    entry.2 = entry.2.max(updated_at);
                }
            }
            for (session_id, (cwd, parent, updated_at)) in metadata {
                db(transaction.execute(
                    "UPDATE sessions SET cwd = ?2, parent_session_id = ?3, updated_at = ?4 WHERE session_id = ?1",
                    params![session_id, cwd, parent, updated_at],
                ))?;
            }
            3
        }
        3 => {
            db(transaction.execute_batch(
                "CREATE TABLE automations (
                   automation_id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0),
                   state TEXT NOT NULL CHECK (state IN ('active','paused','cancelled')),
                   schedule_json TEXT NOT NULL,
                   misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('skip','run-once','catch-up')),
                   retry_max_attempts INTEGER NOT NULL CHECK (retry_max_attempts BETWEEN 1 AND 100),
                   retry_backoff_ms INTEGER NOT NULL CHECK (retry_backoff_ms BETWEEN 0 AND 86400000),
                   action_name TEXT NOT NULL,
                   action_version INTEGER NOT NULL CHECK (action_version > 0),
                   action_payload_json TEXT NOT NULL,
                   created_at INTEGER NOT NULL CHECK (created_at >= 0),
                   updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
                 );
                 CREATE TABLE automation_runs (
                   run_id TEXT PRIMARY KEY,
                   automation_id TEXT NOT NULL REFERENCES automations(automation_id) ON DELETE CASCADE,
                   scheduled_for INTEGER NOT NULL CHECK (scheduled_for >= 0),
                   state TEXT NOT NULL CHECK (state IN ('pending','claimed','succeeded','failed','uncertain')),
                   attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
                   owner_id TEXT,
                   fencing_token INTEGER,
                   lease_expires_at INTEGER,
                   outcome_json TEXT,
                   UNIQUE (automation_id, scheduled_for)
                 );
                 CREATE INDEX automation_runs_claim_idx
                   ON automation_runs(state, lease_expires_at, scheduled_for);",
            ))?;
            4
        }
        4 => {
            db(transaction.execute(
                "ALTER TABLE communications ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0)",
                [],
            ))?;
            db(transaction.execute(
                "CREATE INDEX sessions_navigation_idx
                 ON sessions(cwd, updated_at DESC, session_id ASC)
                 WHERE revision > 0",
                [],
            ))?;
            5
        }
        5 => {
            db(transaction.execute_batch(
                "CREATE TABLE work_graphs (
                   graph_id TEXT PRIMARY KEY
                 );
                 CREATE TABLE work_items (
                   graph_id TEXT NOT NULL REFERENCES work_graphs(graph_id) ON DELETE CASCADE,
                   item_id TEXT NOT NULL,
                   ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                   state TEXT NOT NULL CHECK (state IN ('pending','claimed','succeeded','failed','blocked')),
                   lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
                   owner_id TEXT,
                   lease_expires_at INTEGER,
                   outcome_json TEXT,
                   PRIMARY KEY (graph_id, item_id),
                   UNIQUE (graph_id, ordinal),
                   CHECK ((owner_id IS NULL) = (lease_expires_at IS NULL)),
                   CHECK (state = 'claimed' OR (owner_id IS NULL AND lease_expires_at IS NULL))
                 );
                 CREATE TABLE work_dependencies (
                   graph_id TEXT NOT NULL,
                   item_id TEXT NOT NULL,
                   depends_on_item_id TEXT NOT NULL,
                   PRIMARY KEY (graph_id, item_id, depends_on_item_id),
                   FOREIGN KEY (graph_id, item_id) REFERENCES work_items(graph_id, item_id) ON DELETE CASCADE,
                   FOREIGN KEY (graph_id, depends_on_item_id) REFERENCES work_items(graph_id, item_id) ON DELETE CASCADE,
                   CHECK (item_id <> depends_on_item_id)
                 );
                 CREATE INDEX work_claim_idx
                   ON work_items(graph_id, state, lease_expires_at, ordinal);",
            ))?;
            6
        }
        _ => return Err(ActorError::internal()),
    };
    db(transaction.pragma_update(None, "user_version", next))?;
    db(transaction.commit())?;
    Ok(next)
}

pub struct Actor {
    connection: Connection,
}

impl Actor {
    pub fn open(path: impl AsRef<Path>) -> ActorResult<Self> {
        let path = path.as_ref();
        let mut connection = db(Connection::open(path))?;
        harden_database_permissions(path)?;
        db(connection.busy_timeout(Duration::from_secs(5)))?;
        db_with_startup_retry(|| connection.pragma_update(None, "journal_mode", "WAL"))?;
        db(connection.pragma_update(None, "foreign_keys", true))?;
        let mut version = database_version(&connection)?;
        if version > DATABASE_SCHEMA_VERSION {
            return Err(ActorError::invalid(
                "Database schema is newer than this binary",
            ));
        }
        if version == 0 {
            db_with_startup_retry(|| {
                connection.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS sessions (
                   session_id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0),
                   cwd TEXT,
                   parent_session_id TEXT,
                   updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
                 );
                  CREATE TABLE IF NOT EXISTS session_events (
                   session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                   sequence INTEGER NOT NULL,
                   event_json TEXT NOT NULL,
                    PRIMARY KEY (session_id, sequence)
                  );
                  CREATE INDEX IF NOT EXISTS sessions_navigation_idx
                    ON sessions(cwd, updated_at DESC, session_id ASC)
                    WHERE revision > 0;
                 CREATE TABLE IF NOT EXISTS effects (
                   session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                   effect_key TEXT NOT NULL,
                   state TEXT NOT NULL CHECK (state IN ('started','committed','failed','cancelled','uncertain')),
                    receipt_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                   PRIMARY KEY (session_id, effect_key)
                 );
                 CREATE TABLE IF NOT EXISTS communications (
                   channel TEXT NOT NULL,
                   message_id TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                    available_at INTEGER NOT NULL,
                    lease_consumer TEXT,
                    lease_until INTEGER,
                    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
                    PRIMARY KEY (channel, message_id),
                   CHECK ((lease_consumer IS NULL) = (lease_until IS NULL))
                 );
                 CREATE INDEX IF NOT EXISTS communications_claim_idx
                   ON communications(channel, available_at, lease_until, message_id);
                 CREATE TABLE IF NOT EXISTS settings (
                   scope TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0),
                   values_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS lifecycle_events (
                   stream_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   event_id TEXT NOT NULL,
                   event_json TEXT NOT NULL,
                   PRIMARY KEY (stream_id, sequence),
                   UNIQUE (stream_id, event_id)
                 );
                 CREATE TABLE IF NOT EXISTS automations (
                   automation_id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0),
                   state TEXT NOT NULL CHECK (state IN ('active','paused','cancelled')),
                   schedule_json TEXT NOT NULL,
                   misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('skip','run-once','catch-up')),
                   retry_max_attempts INTEGER NOT NULL CHECK (retry_max_attempts BETWEEN 1 AND 100),
                   retry_backoff_ms INTEGER NOT NULL CHECK (retry_backoff_ms BETWEEN 0 AND 86400000),
                   action_name TEXT NOT NULL,
                   action_version INTEGER NOT NULL CHECK (action_version > 0),
                   action_payload_json TEXT NOT NULL,
                   created_at INTEGER NOT NULL CHECK (created_at >= 0),
                   updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
                 );
                 CREATE TABLE IF NOT EXISTS automation_runs (
                   run_id TEXT PRIMARY KEY,
                   automation_id TEXT NOT NULL REFERENCES automations(automation_id) ON DELETE CASCADE,
                   scheduled_for INTEGER NOT NULL CHECK (scheduled_for >= 0),
                   state TEXT NOT NULL CHECK (state IN ('pending','claimed','succeeded','failed','uncertain')),
                   attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
                   owner_id TEXT,
                   fencing_token INTEGER,
                   lease_expires_at INTEGER,
                   outcome_json TEXT,
                   UNIQUE (automation_id, scheduled_for)
                 );
                 CREATE INDEX IF NOT EXISTS automation_runs_claim_idx
                   ON automation_runs(state, lease_expires_at, scheduled_for);
                 CREATE TABLE IF NOT EXISTS work_graphs (
                   graph_id TEXT PRIMARY KEY
                 );
                 CREATE TABLE IF NOT EXISTS work_items (
                   graph_id TEXT NOT NULL REFERENCES work_graphs(graph_id) ON DELETE CASCADE,
                   item_id TEXT NOT NULL,
                   ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                   state TEXT NOT NULL CHECK (state IN ('pending','claimed','succeeded','failed','blocked')),
                   lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
                   owner_id TEXT,
                   lease_expires_at INTEGER,
                   outcome_json TEXT,
                   PRIMARY KEY (graph_id, item_id),
                   UNIQUE (graph_id, ordinal),
                   CHECK ((owner_id IS NULL) = (lease_expires_at IS NULL)),
                   CHECK (state = 'claimed' OR (owner_id IS NULL AND lease_expires_at IS NULL))
                 );
                 CREATE TABLE IF NOT EXISTS work_dependencies (
                   graph_id TEXT NOT NULL,
                   item_id TEXT NOT NULL,
                   depends_on_item_id TEXT NOT NULL,
                   PRIMARY KEY (graph_id, item_id, depends_on_item_id),
                   FOREIGN KEY (graph_id, item_id) REFERENCES work_items(graph_id, item_id) ON DELETE CASCADE,
                   FOREIGN KEY (graph_id, depends_on_item_id) REFERENCES work_items(graph_id, item_id) ON DELETE CASCADE,
                   CHECK (item_id <> depends_on_item_id)
                 );
                 CREATE INDEX IF NOT EXISTS work_claim_idx
                   ON work_items(graph_id, state, lease_expires_at, ordinal);
                   PRAGMA user_version = 6;
                  COMMIT;",
            )
            })?;
            version = DATABASE_SCHEMA_VERSION;
        }
        while version < DATABASE_SCHEMA_VERSION {
            version = migrate_one(&mut connection, version)?;
        }
        Ok(Self { connection })
    }

    pub fn handle(&mut self, request: Request) -> Response {
        let id = request.id;
        match self.dispatch(&request.method, &request.params) {
            Ok(result) => Response::Ok {
                schema_version: PROTOCOL_VERSION,
                id,
                ok: true,
                result,
            },
            Err(error) => Response::Err {
                schema_version: PROTOCOL_VERSION,
                id,
                ok: false,
                error: ErrorBody {
                    code: error.code,
                    message: error.message,
                },
            },
        }
    }

    fn dispatch(&mut self, method: &str, params: &Value) -> ActorResult<Value> {
        match method {
            "health" => Ok(
                json!({"status":"ok","schemaVersion":PROTOCOL_VERSION,"databaseSchemaVersion":DATABASE_SCHEMA_VERSION}),
            ),
            "session.append" => self.session_append(params),
            "session.load" => self.session_load(params),
            "session.loadPage" => self.session_load_page(params),
            "session.list" => self.session_list(params),
            "effect.begin" => self.effect_begin(params),
            "effect.get" => self.effect_get(params),
            "effect.settle" => self.effect_settle(params),
            "communication.enqueue" => self.communication_enqueue(params),
            "communication.claim" => self.communication_claim(params),
            "communication.ack" => self.communication_ack(params),
            "communication.release" => self.communication_release(params),
            "communication.abandonPrefix" => self.communication_abandon_prefix(params),
            "settings.get" => self.settings_get(params),
            "settings.compareAndSet" => self.settings_compare_and_set(params),
            "lifecycle.append" => self.lifecycle_append(params),
            "lifecycle.list" => self.lifecycle_list(params),
            "automation.put" => self.automation_put(params),
            "automation.list" => self.automation_list(params),
            "automation.cancel" => self.automation_cancel(params),
            "automation.claim" => self.automation_claim(params),
            "automation.heartbeat" => self.automation_heartbeat(params),
            "automation.complete" => self.automation_complete(params),
            "automation.fail" => self.automation_fail(params),
            "automation.uncertain" => self.automation_uncertain(params),
            "work.putGraph" => self.work_put_graph(params),
            "work.getGraph" => self.work_get_graph(params),
            "work.claim" => self.work_claim(params),
            "work.heartbeat" => self.work_heartbeat(params),
            "work.complete" => self.work_settle(params, "succeeded"),
            "work.fail" => self.work_settle(params, "failed"),
            _ => Err(ActorError {
                code: "METHOD_NOT_FOUND",
                message: "Unknown method".into(),
            }),
        }
    }

    fn session_append(&mut self, input: &Value) -> ActorResult<Value> {
        let session_id = required_str(input, "sessionId")?;
        let expected = required_revision(input, "expectedRevision")?;
        let events = input
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| ActorError::invalid("events must be an array"))?;
        let increment =
            i64::try_from(events.len()).map_err(|_| ActorError::invalid("events is too large"))?;
        let next = expected
            .checked_add(increment)
            .ok_or_else(|| ActorError::invalid("revision overflow"))?;
        let index = input.get("index").and_then(Value::as_object);
        let cwd = index
            .and_then(|value| value.get("cwd"))
            .and_then(Value::as_str);
        let parent_session_id = index
            .and_then(|value| value.get("parentSessionId"))
            .and_then(Value::as_str);
        let updated_at = index
            .and_then(|value| value.get("updatedAt"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if updated_at < 0 {
            return Err(ActorError::invalid("index.updatedAt must be non-negative"));
        }
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let current: Option<i64> = db(transaction
            .query_row(
                "SELECT revision FROM sessions WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional())?;
        let current = current.unwrap_or(0);
        if current != expected {
            return Err(ActorError::conflict(format!(
                "Session revision conflict: expected {expected}, current {current}"
            )));
        }
        if current == 0 {
            db(transaction.execute(
                "INSERT OR IGNORE INTO sessions(session_id, revision, cwd, parent_session_id, updated_at) VALUES (?1, 0, ?2, ?3, ?4)",
                params![session_id, cwd, parent_session_id, updated_at],
            ))?;
        }
        for (index, event) in events.iter().enumerate() {
            let sequence = expected + i64::try_from(index).unwrap() + 1;
            let encoded = serde_json::to_string(event)
                .map_err(|_| ActorError::invalid("event is not serializable"))?;
            db(transaction.execute(
                "INSERT INTO session_events(session_id, sequence, event_json) VALUES (?1, ?2, ?3)",
                params![session_id, sequence, encoded],
            ))?;
        }
        db(transaction.execute(
            "UPDATE sessions SET revision = ?2, cwd = COALESCE(?3, cwd), parent_session_id = COALESCE(?4, parent_session_id), updated_at = MAX(updated_at, ?5) WHERE session_id = ?1",
            params![session_id, next, cwd, parent_session_id, updated_at],
        ))?;
        db(transaction.commit())?;
        Ok(json!({"revision":next.to_string()}))
    }

    fn session_load(&self, input: &Value) -> ActorResult<Value> {
        let session_id = required_str(input, "sessionId")?;
        let revision: Option<i64> = db(self
            .connection
            .query_row(
                "SELECT revision FROM sessions WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional())?;
        let Some(revision) = revision else {
            return Ok(Value::Null);
        };
        let mut statement = db(self.connection.prepare(
            "SELECT event_json FROM session_events WHERE session_id = ?1 ORDER BY sequence ASC",
        ))?;
        let rows = db(statement.query_map([session_id], |row| row.get::<_, String>(0)))?;
        let mut events = Vec::new();
        for row in rows {
            let encoded = db(row)?;
            events
                .push(serde_json::from_str::<Value>(&encoded).map_err(|_| ActorError::internal())?);
        }
        Ok(json!({"sessionId":session_id,"revision":revision.to_string(),"events":events}))
    }

    fn session_load_page(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(
            input,
            &[
                "sessionId",
                "afterSequence",
                "expectedRevision",
                "maxEvents",
                "maxBytes",
            ],
        )?;
        let session_id = required_str(input, "sessionId")?.to_owned();
        let after_value = input
            .get("afterSequence")
            .cloned()
            .ok_or_else(|| ActorError::invalid("afterSequence is required"))?;
        let after_sequence = if after_value.is_null() {
            0
        } else {
            required_revision(input, "afterSequence")?
        };
        let expected_revision = match input.get("expectedRevision") {
            Some(Value::Null) => None,
            Some(_) => Some(required_revision(input, "expectedRevision")?),
            None => return Err(ActorError::invalid("expectedRevision is required")),
        };
        let max_events = required_i64(input, "maxEvents")?;
        if !(1..=1000).contains(&max_events) {
            return Err(ActorError::invalid("maxEvents must be between 1 and 1000"));
        }
        let max_bytes = required_i64(input, "maxBytes")?;
        let max_bytes = usize::try_from(max_bytes).map_err(|_| {
            ActorError::invalid("maxBytes must be within the session page byte range")
        })?;
        if !(MIN_SESSION_PAGE_RESULT_BYTES..=MAX_SESSION_PAGE_RESULT_BYTES).contains(&max_bytes) {
            return Err(ActorError::invalid(format!(
                "maxBytes must be between {MIN_SESSION_PAGE_RESULT_BYTES} and {MAX_SESSION_PAGE_RESULT_BYTES}"
            )));
        }

        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Deferred))?;
        let revision: Option<i64> = db(transaction
            .query_row(
                "SELECT revision FROM sessions WHERE session_id = ?1",
                [&session_id],
                |row| row.get(0),
            )
            .optional())?;
        let Some(revision) = revision else {
            if expected_revision.is_some() || after_sequence != 0 {
                return Err(ActorError::conflict("Session page snapshot is stale"));
            }
            db(transaction.commit())?;
            return Ok(Value::Null);
        };
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(ActorError::conflict("Session page snapshot is stale"));
        }
        if after_sequence > revision {
            return Err(ActorError::invalid(
                "afterSequence must not exceed the session revision",
            ));
        }

        let rows = {
            let mut statement = db(transaction.prepare(
                "SELECT sequence, event_json FROM session_events
                 WHERE session_id = ?1 AND sequence > ?2 AND sequence <= ?3
                 ORDER BY sequence ASC LIMIT ?4",
            ))?;
            let mapped = db(statement.query_map(
                params![session_id, after_sequence, revision, max_events],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            ))?;
            let mut rows = Vec::new();
            for row in mapped {
                rows.push(db(row)?);
            }
            rows
        };

        let revision_string = revision.to_string();
        let mut entries = Vec::new();
        let mut encoded_entries_bytes = 0usize;
        let mut last_sequence = after_sequence;
        let mut done = after_sequence == revision;
        for (sequence, encoded) in rows {
            let expected_sequence = last_sequence
                .checked_add(1)
                .ok_or_else(ActorError::internal)?;
            if sequence != expected_sequence {
                return Err(ActorError::internal());
            }
            let event: Value =
                serde_json::from_str(&encoded).map_err(|_| ActorError::internal())?;
            let entry = json!({"sequence":sequence.to_string(),"event":event});
            let entry_bytes = serde_json::to_vec(&entry)
                .map_err(|_| ActorError::internal())?
                .len();
            let candidate_done = sequence == revision;
            let candidate_next = if candidate_done {
                Value::Null
            } else {
                Value::String(sequence.to_string())
            };
            let empty_candidate = json!({
                "sessionId":session_id,
                "revision":revision_string,
                "afterSequence":after_value,
                "events":[],
                "nextCursor":candidate_next,
                "done":candidate_done
            });
            let empty_bytes = serde_json::to_vec(&empty_candidate)
                .map_err(|_| ActorError::internal())?
                .len();
            let candidate_entries_bytes = encoded_entries_bytes
                .checked_add(usize::from(!entries.is_empty()))
                .and_then(|value| value.checked_add(entry_bytes))
                .ok_or_else(ActorError::internal)?;
            let candidate_bytes = empty_bytes
                .checked_sub(2)
                .and_then(|value| value.checked_add(candidate_entries_bytes))
                .ok_or_else(ActorError::internal)?;
            if candidate_bytes > max_bytes {
                if entries.is_empty() {
                    return Err(ActorError::frame_too_large(
                        "Session event exceeds the requested page byte limit",
                    ));
                }
                break;
            }
            entries.push(entry);
            encoded_entries_bytes = candidate_entries_bytes;
            last_sequence = sequence;
            done = candidate_done;
        }
        if entries.is_empty() && !done {
            return Err(ActorError::internal());
        }
        let next_cursor = if done {
            Value::Null
        } else {
            Value::String(last_sequence.to_string())
        };
        let page = json!({
            "sessionId":session_id,
            "revision":revision_string,
            "afterSequence":after_value,
            "events":entries,
            "nextCursor":next_cursor,
            "done":done
        });
        let encoded_page_bytes = serde_json::to_vec(&page)
            .map_err(|_| ActorError::internal())?
            .len();
        if encoded_page_bytes > max_bytes {
            return Err(ActorError::internal());
        }
        db(transaction.commit())?;
        Ok(page)
    }

    fn session_list(&self, input: &Value) -> ActorResult<Value> {
        let cwd = required_str(input, "cwd")?;
        let limit = required_i64(input, "limit")?;
        if !(1..=1000).contains(&limit) {
            return Err(ActorError::invalid("limit must be between 1 and 1000"));
        }
        let mut statement = db(self.connection.prepare(
            "SELECT session_id, revision, parent_session_id, updated_at FROM sessions
             WHERE cwd = ?1 AND revision > 0 ORDER BY updated_at DESC, session_id ASC LIMIT ?2",
        ))?;
        let mapped = db(statement.query_map(params![cwd, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        }))?;
        let mut sessions = Vec::new();
        for row in mapped {
            let (session_id, revision, parent_session_id, updated_at) = db(row)?;
            sessions.push(json!({
                "sessionId": session_id,
                "revision": revision.to_string(),
                "cwd": cwd,
                "parentSessionId": parent_session_id,
                "updatedAt": updated_at,
            }));
        }
        Ok(Value::Array(sessions))
    }

    fn effect_begin(&mut self, input: &Value) -> ActorResult<Value> {
        let session_id = required_str(input, "sessionId")?;
        let key = required_str(input, "key")?;
        let receipt = input
            .get("receipt")
            .ok_or_else(|| ActorError::invalid("receipt is required"))?;
        let encoded = serde_json::to_string(receipt)
            .map_err(|_| ActorError::invalid("receipt is not serializable"))?;
        let updated_at = now_ms()?;
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let existing: Option<(String, String)> = db(transaction
            .query_row(
                "SELECT state, receipt_json FROM effects WHERE session_id = ?1 AND effect_key = ?2",
                params![session_id, key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional())?;
        if let Some((state, prior)) = existing {
            db(transaction.commit())?;
            return Ok(Value::String(if prior == encoded {
                state
            } else {
                "mismatch".into()
            }));
        }
        let session_exists: bool = db(transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id = ?1)",
            [session_id],
            |row| row.get(0),
        ))?;
        if !session_exists {
            return Err(ActorError::not_found("Session does not exist"));
        }
        db(transaction.execute(
            "INSERT INTO effects(session_id, effect_key, state, receipt_json, updated_at) VALUES (?1, ?2, 'started', ?3, ?4)",
            params![session_id, key, encoded, updated_at],
        ))?;
        db(transaction.commit())?;
        Ok(Value::String("acquired".into()))
    }

    fn effect_get(&self, input: &Value) -> ActorResult<Value> {
        let session_id = required_str(input, "sessionId")?;
        let key = required_str(input, "key")?;
        let existing: Option<(String, String, i64)> = db(self.connection.query_row(
            "SELECT state, receipt_json, updated_at FROM effects WHERE session_id = ?1 AND effect_key = ?2",
            params![session_id, key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional())?;
        match existing {
            None => Ok(Value::Null),
            Some((state, receipt, updated_at)) => {
                let receipt: Value =
                    serde_json::from_str(&receipt).map_err(|_| ActorError::internal())?;
                Ok(json!({"key":key,"state":state,"receipt":receipt,"updatedAt":updated_at}))
            }
        }
    }

    fn effect_settle(&mut self, input: &Value) -> ActorResult<Value> {
        let session_id = required_str(input, "sessionId")?;
        let key = required_str(input, "key")?;
        let target = required_str(input, "state")?;
        if !TERMINAL_EFFECT_STATES.contains(&target) {
            return Err(ActorError::invalid(
                "state must be committed, failed, cancelled, or uncertain",
            ));
        }
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let current: Option<String> = db(transaction
            .query_row(
                "SELECT state FROM effects WHERE session_id = ?1 AND effect_key = ?2",
                params![session_id, key],
                |row| row.get(0),
            )
            .optional())?;
        let Some(current) = current else {
            return Err(ActorError::not_found("Effect does not exist"));
        };
        if current == target {
            db(transaction.commit())?;
            return Ok(Value::String(target.into()));
        }
        if current != "started" {
            return Err(ActorError::conflict(format!(
                "Effect is already terminal with state {current}"
            )));
        }
        let updated_at = now_ms()?;
        db(transaction.execute(
            "UPDATE effects SET state = ?3, updated_at = ?4 WHERE session_id = ?1 AND effect_key = ?2",
            params![session_id, key, target, updated_at],
        ))?;
        db(transaction.commit())?;
        Ok(Value::String(target.into()))
    }

    fn communication_enqueue(&mut self, input: &Value) -> ActorResult<Value> {
        let channel = required_str(input, "channel")?;
        let message_id = required_str(input, "messageId")?;
        let available_at = required_i64(input, "availableAt")?;
        let payload = input
            .get("payload")
            .ok_or_else(|| ActorError::invalid("payload is required"))?;
        let encoded = serde_json::to_string(payload)
            .map_err(|_| ActorError::invalid("payload is not serializable"))?;
        match self.connection.execute(
            "INSERT INTO communications(channel, message_id, payload_json, available_at) VALUES (?1, ?2, ?3, ?4)",
            params![channel, message_id, encoded, available_at],
        ) {
            Ok(_) => Ok(json!({"enqueued":true})),
            Err(rusqlite::Error::SqliteFailure(ref detail, _))
                if detail.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY => {
                Err(ActorError::conflict("Message already exists"))
            }
            Err(_) => Err(ActorError::internal()),
        }
    }

    fn communication_claim(&mut self, input: &Value) -> ActorResult<Value> {
        let channel = required_str(input, "channel")?;
        let consumer_id = required_str(input, "consumerId")?;
        let now = required_i64(input, "now")?;
        let lease_ms = required_i64(input, "leaseMs")?;
        let limit = required_i64(input, "limit")?;
        if lease_ms <= 0 {
            return Err(ActorError::invalid("leaseMs must be positive"));
        }
        if !(1..=1000).contains(&limit) {
            return Err(ActorError::invalid("limit must be between 1 and 1000"));
        }
        let lease_until = now
            .checked_add(lease_ms)
            .ok_or_else(|| ActorError::invalid("lease deadline overflow"))?;
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let rows: Vec<(String, String, i64)> = {
            let mut statement = db(transaction.prepare(
                "SELECT message_id, payload_json, available_at FROM communications
                 WHERE channel = ?1 AND available_at <= ?2 AND (lease_until IS NULL OR lease_until <= ?2)
                 ORDER BY available_at ASC, message_id ASC LIMIT ?3",
            ))?;
            let mapped = db(statement.query_map(params![channel, now, limit], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            }))?;
            let mut rows = Vec::new();
            for row in mapped {
                rows.push(db(row)?);
            }
            rows
        };
        let mut claimed = Vec::new();
        for (message_id, payload, available_at) in rows {
            db(transaction.execute(
                "UPDATE communications
                 SET lease_consumer = ?3, lease_until = ?4,
                     lease_generation = lease_generation + 1
                 WHERE channel = ?1 AND message_id = ?2",
                params![channel, message_id, consumer_id, lease_until],
            ))?;
            let lease_generation: i64 = db(transaction.query_row(
                "SELECT lease_generation FROM communications
                 WHERE channel = ?1 AND message_id = ?2",
                params![channel, message_id],
                |row| row.get(0),
            ))?;
            let payload: Value =
                serde_json::from_str(&payload).map_err(|_| ActorError::internal())?;
            claimed.push(json!({
                "messageId":message_id,"payload":payload,"availableAt":available_at,
                "leaseUntil":lease_until,"leaseGeneration":lease_generation
            }));
        }
        db(transaction.commit())?;
        Ok(Value::Array(claimed))
    }

    fn communication_ack(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(
            input,
            &["channel", "messageId", "consumerId", "leaseGeneration"],
        )?;
        let channel = required_str(input, "channel")?;
        let message_id = required_str(input, "messageId")?;
        let consumer_id = required_str(input, "consumerId")?;
        let lease_generation = required_non_negative_i64(input, "leaseGeneration")?;
        let changed = db(self.connection.execute(
            "DELETE FROM communications
             WHERE channel = ?1 AND message_id = ?2 AND lease_consumer = ?3
               AND lease_generation = ?4",
            params![channel, message_id, consumer_id, lease_generation],
        ))?;
        if changed == 0 {
            return Err(ActorError::conflict("Message lease receipt is stale"));
        }
        Ok(json!({"acknowledged":true}))
    }

    fn communication_release(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(
            input,
            &["channel", "messageId", "consumerId", "leaseGeneration"],
        )?;
        let channel = required_str(input, "channel")?;
        let message_id = required_str(input, "messageId")?;
        let consumer_id = required_str(input, "consumerId")?;
        let lease_generation = required_non_negative_i64(input, "leaseGeneration")?;
        let changed = db(self.connection.execute(
            "UPDATE communications SET lease_consumer = NULL, lease_until = NULL
             WHERE channel = ?1 AND message_id = ?2 AND lease_consumer = ?3
               AND lease_generation = ?4",
            params![channel, message_id, consumer_id, lease_generation],
        ))?;
        if changed == 0 {
            return Err(ActorError::conflict("Message lease receipt is stale"));
        }
        Ok(json!({"released":true}))
    }

    fn communication_abandon_prefix(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(input, &["channelPrefix", "limit"])?;
        let channel_prefix = required_str(input, "channelPrefix")?;
        let limit = required_i64(input, "limit")?;
        if !(1..=1000).contains(&limit) {
            return Err(ActorError::invalid("limit must be between 1 and 1000"));
        }
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let rows: Vec<(String, String)> = {
            let mut statement = db(transaction.prepare(
                "SELECT channel, message_id FROM communications
                 WHERE substr(channel, 1, length(?1)) = ?1
                 ORDER BY channel ASC, message_id ASC LIMIT ?2",
            ))?;
            let mapped = db(statement.query_map(params![channel_prefix, limit], |row| {
                Ok((row.get(0)?, row.get(1)?))
            }))?;
            let mut rows = Vec::new();
            for row in mapped {
                rows.push(db(row)?);
            }
            rows
        };
        for (channel, message_id) in &rows {
            db(transaction.execute(
                "DELETE FROM communications WHERE channel = ?1 AND message_id = ?2",
                params![channel, message_id],
            ))?;
        }
        db(transaction.commit())?;
        Ok(Value::Array(
            rows.into_iter()
                .map(|(channel, message_id)| json!({"channel":channel,"messageId":message_id}))
                .collect(),
        ))
    }

    fn settings_get(&self, input: &Value) -> ActorResult<Value> {
        let scope = required_str(input, "scope")?;
        let stored: Option<(i64, String)> = db(self
            .connection
            .query_row(
                "SELECT revision, values_json FROM settings WHERE scope = ?1",
                [scope],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional())?;
        match stored {
            None => Ok(json!({"revision":"0","values":{}})),
            Some((revision, encoded)) => {
                let values: Value =
                    serde_json::from_str(&encoded).map_err(|_| ActorError::internal())?;
                Ok(json!({"revision":revision.to_string(),"values":values}))
            }
        }
    }

    fn settings_compare_and_set(&mut self, input: &Value) -> ActorResult<Value> {
        let scope = required_str(input, "scope")?;
        let expected = required_revision(input, "expectedRevision")?;
        let values = input
            .get("values")
            .and_then(Value::as_object)
            .ok_or_else(|| ActorError::invalid("values must be an object"))?;
        let encoded = serde_json::to_string(values)
            .map_err(|_| ActorError::invalid("values is not serializable"))?;
        let next = expected
            .checked_add(1)
            .ok_or_else(|| ActorError::invalid("revision overflow"))?;
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let current: Option<i64> = db(transaction
            .query_row(
                "SELECT revision FROM settings WHERE scope = ?1",
                [scope],
                |row| row.get(0),
            )
            .optional())?;
        let current = current.unwrap_or(0);
        if current != expected {
            return Err(ActorError::conflict(format!(
                "Settings revision conflict: expected {expected}, current {current}"
            )));
        }
        if current == 0 {
            db(transaction.execute(
                "INSERT INTO settings(scope, revision, values_json) VALUES (?1, ?2, ?3)",
                params![scope, next, encoded],
            ))?;
        } else {
            db(transaction.execute(
                "UPDATE settings SET revision = ?2, values_json = ?3 WHERE scope = ?1",
                params![scope, next, encoded],
            ))?;
        }
        db(transaction.commit())?;
        Ok(json!({"revision":next.to_string()}))
    }

    fn automation_put(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(
            input,
            &[
                "schemaVersion",
                "id",
                "revision",
                "state",
                "schedule",
                "misfirePolicy",
                "retryPolicy",
                "action",
                "createdAt",
                "updatedAt",
            ],
        )?;
        if required_i64(input, "schemaVersion")? != 1 {
            return Err(ActorError::invalid("schemaVersion must be 1"));
        }
        let automation_id = required_str(input, "id")?;
        let revision = required_non_negative_i64(input, "revision")?;
        let state = required_str(input, "state")?;
        if !matches!(state, "active" | "paused" | "cancelled") {
            return Err(ActorError::invalid("state is invalid"));
        }
        let schedule = input
            .get("schedule")
            .ok_or_else(|| ActorError::invalid("schedule is required"))?;
        validate_schedule(schedule)?;
        let misfire_policy = required_str(input, "misfirePolicy")?;
        if !matches!(misfire_policy, "skip" | "run-once" | "catch-up") {
            return Err(ActorError::invalid("misfirePolicy is invalid"));
        }
        let retry_policy = input
            .get("retryPolicy")
            .ok_or_else(|| ActorError::invalid("retryPolicy must be an object"))?;
        reject_unknown_keys(retry_policy, &["maxAttempts", "backoffMs"])?;
        let retry_max_attempts = required_i64(retry_policy, "maxAttempts")?;
        if !(1..=100).contains(&retry_max_attempts) {
            return Err(ActorError::invalid(
                "retryPolicy.maxAttempts must be between 1 and 100",
            ));
        }
        let retry_backoff_ms = required_i64(retry_policy, "backoffMs")?;
        if !(0..=86_400_000).contains(&retry_backoff_ms) {
            return Err(ActorError::invalid(
                "retryPolicy.backoffMs must be between 0 and 86400000",
            ));
        }
        let action = input
            .get("action")
            .ok_or_else(|| ActorError::invalid("action must be an object"))?;
        reject_unknown_keys(action, &["name", "version", "payload"])?;
        let action_name = required_str(action, "name")?;
        let action_version = required_i64(action, "version")?;
        if action_version <= 0 {
            return Err(ActorError::invalid("action.version must be positive"));
        }
        let action_payload = action
            .get("payload")
            .ok_or_else(|| ActorError::invalid("action.payload is required"))?;
        let created_at = required_non_negative_i64(input, "createdAt")?;
        let updated_at = required_non_negative_i64(input, "updatedAt")?;
        if updated_at < created_at {
            return Err(ActorError::invalid("updatedAt must not precede createdAt"));
        }
        let schedule_json = serde_json::to_string(schedule)
            .map_err(|_| ActorError::invalid("schedule is not serializable"))?;
        let payload_json = serde_json::to_string(action_payload)
            .map_err(|_| ActorError::invalid("action.payload is not serializable"))?;
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let existing: Option<(i64, i64, i64)> = db(transaction
            .query_row(
                "SELECT revision, created_at, updated_at FROM automations WHERE automation_id = ?1",
                [automation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional())?;
        match existing {
            None if revision != 0 => {
                return Err(ActorError::conflict("New automation revision must be 0"))
            }
            Some((current, _, _)) if revision != current + 1 => {
                return Err(ActorError::conflict(format!(
                    "Automation revision conflict: expected {}, received {revision}",
                    current + 1
                )));
            }
            Some((_, prior_created, prior_updated))
                if created_at != prior_created || updated_at < prior_updated =>
            {
                return Err(ActorError::conflict(
                    "Automation timestamps conflict with stored definition",
                ));
            }
            _ => {}
        }
        db(transaction.execute(
            "INSERT INTO automations(automation_id, revision, state, schedule_json, misfire_policy,
               retry_max_attempts, retry_backoff_ms, action_name, action_version,
               action_payload_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(automation_id) DO UPDATE SET revision=excluded.revision, state=excluded.state,
               schedule_json=excluded.schedule_json, misfire_policy=excluded.misfire_policy,
               retry_max_attempts=excluded.retry_max_attempts,
               retry_backoff_ms=excluded.retry_backoff_ms,
               action_name=excluded.action_name, action_version=excluded.action_version,
               action_payload_json=excluded.action_payload_json, updated_at=excluded.updated_at",
            params![automation_id, revision, state, schedule_json, misfire_policy,
                retry_max_attempts, retry_backoff_ms, action_name, action_version,
                payload_json, created_at, updated_at],
        ))?;
        db(transaction.commit())?;
        Ok(input.clone())
    }

    fn automation_list(&self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(input, &["limit", "states"])?;
        let limit = required_i64(input, "limit")?;
        if !(1..=100).contains(&limit) {
            return Err(ActorError::invalid("limit must be between 1 and 100"));
        }
        let states = input
            .get("states")
            .map(|value| {
                value
                    .as_array()
                    .ok_or_else(|| ActorError::invalid("states must be an array"))
            })
            .transpose()?;
        if let Some(states) = states {
            if states.len() > 3
                || states
                    .iter()
                    .any(|state| !matches!(state.as_str(), Some("active" | "paused" | "cancelled")))
            {
                return Err(ActorError::invalid("states contains an invalid state"));
            }
        }
        let mut statement = db(self.connection.prepare(
            "SELECT automation_id, revision, state, schedule_json, misfire_policy,
                    retry_max_attempts, retry_backoff_ms, action_name, action_version,
                    action_payload_json, created_at, updated_at
             FROM automations ORDER BY automation_id ASC LIMIT 1000",
        ))?;
        let mapped = db(statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, i64>(11)?,
            ))
        }))?;
        let mut definitions = Vec::new();
        for row in mapped {
            let (
                id,
                revision,
                state,
                schedule,
                policy,
                retry_max_attempts,
                retry_backoff_ms,
                action_name,
                action_version,
                payload,
                created_at,
                updated_at,
            ) = db(row)?;
            if states.is_some_and(|states| {
                !states
                    .iter()
                    .any(|candidate| candidate.as_str() == Some(&state))
            }) {
                continue;
            }
            let schedule: Value =
                serde_json::from_str(&schedule).map_err(|_| ActorError::internal())?;
            let payload: Value =
                serde_json::from_str(&payload).map_err(|_| ActorError::internal())?;
            definitions.push(json!({
                "schemaVersion":1,"id":id,"revision":revision,"state":state,"schedule":schedule,
                "misfirePolicy":policy,"retryPolicy":{"maxAttempts":retry_max_attempts,"backoffMs":retry_backoff_ms},
                "action":{"name":action_name,"version":action_version,"payload":payload},
                "createdAt":created_at,"updatedAt":updated_at
            }));
            if definitions.len() >= usize::try_from(limit).unwrap_or(100) {
                break;
            }
        }
        Ok(Value::Array(definitions))
    }

    fn automation_definition_value(&self, automation_id: &str) -> ActorResult<Option<Value>> {
        let stored: Option<AutomationDefinitionRecord> = db(self
            .connection
            .query_row(
                "SELECT revision, state, schedule_json, misfire_policy,
                            retry_max_attempts, retry_backoff_ms, action_name,
                            action_version, action_payload_json, created_at, updated_at
                     FROM automations WHERE automation_id = ?1",
                [automation_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                    ))
                },
            )
            .optional())?;
        let Some((
            revision,
            state,
            schedule,
            policy,
            retry_max_attempts,
            retry_backoff_ms,
            action_name,
            action_version,
            payload,
            created_at,
            updated_at,
        )) = stored
        else {
            return Ok(None);
        };
        let schedule: Value =
            serde_json::from_str(&schedule).map_err(|_| ActorError::internal())?;
        let payload: Value = serde_json::from_str(&payload).map_err(|_| ActorError::internal())?;
        Ok(Some(json!({
            "schemaVersion":1,"id":automation_id,"revision":revision,"state":state,
            "schedule":schedule,"misfirePolicy":policy,
            "retryPolicy":{"maxAttempts":retry_max_attempts,"backoffMs":retry_backoff_ms},
            "action":{"name":action_name,"version":action_version,"payload":payload},
            "createdAt":created_at,"updatedAt":updated_at
        })))
    }

    fn automation_cancel(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(input, &["id", "expectedRevision", "cancelledAt"])?;
        let automation_id = required_str(input, "id")?;
        let expected_revision = required_non_negative_i64(input, "expectedRevision")?;
        let cancelled_at = required_non_negative_i64(input, "cancelledAt")?;
        let changed = db(self.connection.execute(
            "UPDATE automations SET state='cancelled', revision=revision+1, updated_at=?3
             WHERE automation_id=?1 AND revision=?2 AND ?3 >= created_at AND ?3 >= updated_at",
            params![automation_id, expected_revision, cancelled_at],
        ))?;
        if changed == 0 {
            let exists: bool = db(self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM automations WHERE automation_id=?1)",
                [automation_id],
                |row| row.get(0),
            ))?;
            return Err(if exists {
                ActorError::conflict("Automation revision or timestamp conflict")
            } else {
                ActorError::not_found("Automation does not exist")
            });
        }
        self.automation_definition_value(automation_id)?
            .ok_or_else(ActorError::internal)
    }

    fn automation_claim(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(input, &["ownerId", "now", "leaseMs", "limit", "candidates"])?;
        let owner_id = required_str(input, "ownerId")?;
        let now = required_non_negative_i64(input, "now")?;
        let lease_ms = required_i64(input, "leaseMs")?;
        if !(1..=86_400_000).contains(&lease_ms) {
            return Err(ActorError::invalid(
                "leaseMs must be between 1 and 86400000",
            ));
        }
        let lease_expires_at = now
            .checked_add(lease_ms)
            .ok_or_else(|| ActorError::invalid("lease deadline overflow"))?;
        let limit = required_i64(input, "limit")?;
        if !(1..=100).contains(&limit) {
            return Err(ActorError::invalid("limit must be between 1 and 100"));
        }
        let candidates = input
            .get("candidates")
            .and_then(Value::as_array)
            .ok_or_else(|| ActorError::invalid("candidates must be an array"))?;
        if candidates.is_empty() || candidates.len() > usize::try_from(limit).unwrap_or(100) {
            return Err(ActorError::invalid(
                "candidates must be non-empty and contain at most limit entries",
            ));
        }
        // TypeScript deterministically expands schedules into bounded candidates. This
        // transaction is the authority that materializes, deduplicates, and leases them.
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let mut claims = Vec::new();
        for candidate in candidates {
            if claims.len() >= usize::try_from(limit).unwrap_or(100) {
                break;
            }
            reject_unknown_keys(candidate, &["automationId", "scheduledFor"])?;
            let automation_id = required_str(candidate, "automationId")?;
            let scheduled_for = required_non_negative_i64(candidate, "scheduledFor")?;
            let active: Option<i64> = db(transaction
                .query_row(
                    "SELECT 1 FROM automations
                  WHERE automation_id=?1 AND state='active'",
                    [automation_id],
                    |row| row.get(0),
                )
                .optional())?;
            if active.is_none() {
                continue;
            }
            let generated_run_id: String =
                db(transaction
                    .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0)))?;
            db(transaction.execute(
                "INSERT OR IGNORE INTO automation_runs(run_id,automation_id,scheduled_for,state,attempt)
                 VALUES (?1,?2,?3,'pending',0)",
                params![generated_run_id, automation_id, scheduled_for],
            ))?;
            let run: (String, String, i64, Option<i64>) = db(transaction.query_row(
                "SELECT run_id,state,attempt,lease_expires_at FROM automation_runs
                 WHERE automation_id=?1 AND scheduled_for=?2",
                params![automation_id, scheduled_for],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ))?;
            if !(run.1 == "pending"
                || (run.1 == "claimed" && run.3.is_some_and(|lease| lease <= now)))
            {
                continue;
            }
            let attempt = run.2 + 1;
            // The per-run attempt is a strictly increasing fencing generation.
            // Unlike a random token it cannot collide with an earlier claimant.
            let fencing_token = attempt;
            db(transaction.execute(
                "UPDATE automation_runs SET state='claimed',attempt=?2,owner_id=?3,
                 fencing_token=?4,lease_expires_at=?5,outcome_json=NULL WHERE run_id=?1",
                params![run.0, attempt, owner_id, fencing_token, lease_expires_at],
            ))?;
            claims.push(
                json!({"schemaVersion":1,"runId":run.0,"automationId":automation_id,
                "scheduledFor":scheduled_for,"attempt":attempt,"state":"claimed","ownerId":owner_id,
                "leaseExpiresAt":lease_expires_at,"fencingToken":fencing_token}),
            );
        }
        db(transaction.commit())?;
        Ok(Value::Array(claims))
    }

    fn automation_heartbeat(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(
            input,
            &["runId", "ownerId", "fencingToken", "now", "leaseMs"],
        )?;
        let run_id = required_str(input, "runId")?;
        let owner_id = required_str(input, "ownerId")?;
        let token = required_i64(input, "fencingToken")?;
        let now = required_non_negative_i64(input, "now")?;
        let lease_ms = required_i64(input, "leaseMs")?;
        if !(1..=86_400_000).contains(&lease_ms) {
            return Err(ActorError::invalid(
                "leaseMs must be between 1 and 86400000",
            ));
        }
        let expires = now
            .checked_add(lease_ms)
            .ok_or_else(|| ActorError::invalid("lease deadline overflow"))?;
        let changed = db(self.connection.execute(
            "UPDATE automation_runs SET lease_expires_at=?5 WHERE run_id=?1 AND state='claimed'
             AND owner_id=?2 AND fencing_token=?3 AND lease_expires_at>?4",
            params![run_id, owner_id, token, now, expires],
        ))?;
        if changed == 0 {
            return Err(ActorError::conflict(
                "Automation lease is expired or fencing token is stale",
            ));
        }
        self.automation_claim_value(run_id)
    }

    fn automation_claim_value(&self, run_id: &str) -> ActorResult<Value> {
        let row: (String, i64, i64, String, i64, i64) = db(self.connection.query_row(
            "SELECT automation_id,scheduled_for,attempt,owner_id,lease_expires_at,
                    fencing_token
             FROM automation_runs
             WHERE run_id=?1 AND state='claimed'",
            [run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        ))?;
        Ok(
            json!({"schemaVersion":1,"runId":run_id,"automationId":row.0,"scheduledFor":row.1,
            "attempt":row.2,"state":"claimed","ownerId":row.3,"leaseExpiresAt":row.4,
            "fencingToken":row.5}),
        )
    }

    fn automation_complete(&mut self, input: &Value) -> ActorResult<Value> {
        self.automation_settle(input, "succeeded")
    }

    fn automation_fail(&mut self, input: &Value) -> ActorResult<Value> {
        self.automation_settle(input, "failed")
    }

    fn automation_uncertain(&mut self, input: &Value) -> ActorResult<Value> {
        self.automation_settle(input, "uncertain")
    }

    fn automation_settle(&mut self, input: &Value, terminal: &str) -> ActorResult<Value> {
        reject_unknown_keys(input, &["runId", "ownerId", "fencingToken", "outcome"])?;
        let run_id = required_str(input, "runId")?;
        let owner_id = required_str(input, "ownerId")?;
        let token = required_i64(input, "fencingToken")?;
        let outcome = input
            .get("outcome")
            .ok_or_else(|| ActorError::invalid("outcome is required"))?;
        let outcome_state = required_str(outcome, "state")?;
        if outcome_state != terminal {
            return Err(ActorError::invalid("outcome.state does not match method"));
        }
        let completed_at = required_non_negative_i64(outcome, "completedAt")?;
        match terminal {
            "succeeded" => reject_unknown_keys(outcome, &["state", "completedAt", "result"])?,
            "failed" => {
                reject_unknown_keys(outcome, &["state", "completedAt", "error"])?;
                let error = outcome
                    .get("error")
                    .ok_or_else(|| ActorError::invalid("outcome.error is required"))?;
                reject_unknown_keys(error, &["code", "message", "retryable", "details"])?;
                required_str(error, "code")?;
                required_str(error, "message")?;
                if !matches!(error.get("retryable"), Some(Value::Bool(_))) {
                    return Err(ActorError::invalid(
                        "outcome.error.retryable must be boolean",
                    ));
                }
            }
            "uncertain" => {
                reject_unknown_keys(outcome, &["state", "completedAt", "reason", "details"])?;
                required_str(outcome, "reason")?;
            }
            _ => return Err(ActorError::internal()),
        }
        let encoded = serde_json::to_string(outcome)
            .map_err(|_| ActorError::invalid("outcome is not serializable"))?;
        let changed = db(self.connection.execute(
            "UPDATE automation_runs SET state=?5,outcome_json=?6,owner_id=NULL,fencing_token=NULL,lease_expires_at=NULL
             WHERE run_id=?1 AND state='claimed' AND owner_id=?2 AND fencing_token=?3 AND lease_expires_at>?4",
            params![run_id,owner_id,token,completed_at,terminal,encoded],
        ))?;
        if changed == 0 {
            return Err(ActorError::conflict(
                "Automation lease is expired or fencing token is stale",
            ));
        }
        let row: (String, i64, i64) = db(self.connection.query_row(
            "SELECT automation_id,scheduled_for,attempt FROM automation_runs WHERE run_id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ))?;
        Ok(
            json!({"schemaVersion":1,"runId":run_id,"automationId":row.0,"scheduledFor":row.1,
            "attempt":row.2,"state":terminal,"outcome":outcome}),
        )
    }

    fn work_put_graph(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(input, &["graphId", "items"])?;
        let graph_id = required_str(input, "graphId")?;
        if graph_id.len() > 512 {
            return Err(ActorError::invalid("graphId must be at most 512 bytes"));
        }
        let items = input
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| ActorError::invalid("items must be an array"))?;
        if items.is_empty() || items.len() > 1000 {
            return Err(ActorError::invalid(
                "items must contain between 1 and 1000 entries",
            ));
        }

        let mut ids = HashSet::with_capacity(items.len());
        let mut graph = Vec::with_capacity(items.len());
        for item in items {
            reject_unknown_keys(item, &["itemId", "dependsOn"])?;
            let item_id = required_str(item, "itemId")?;
            if item_id.len() > 512 {
                return Err(ActorError::invalid("itemId must be at most 512 bytes"));
            }
            if !ids.insert(item_id.to_owned()) {
                return Err(ActorError::invalid("itemId values must be unique"));
            }
            let dependencies = item
                .get("dependsOn")
                .and_then(Value::as_array)
                .ok_or_else(|| ActorError::invalid("dependsOn must be an array"))?;
            if dependencies.len() > 1000 {
                return Err(ActorError::invalid(
                    "dependsOn must contain at most 1000 entries",
                ));
            }
            let mut dependency_ids = Vec::with_capacity(dependencies.len());
            let mut unique_dependencies = HashSet::with_capacity(dependencies.len());
            for dependency in dependencies {
                let dependency = dependency
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ActorError::invalid("dependsOn entries must be non-empty strings")
                    })?;
                if dependency.len() > 512 {
                    return Err(ActorError::invalid(
                        "dependsOn entries must be at most 512 bytes",
                    ));
                }
                if !unique_dependencies.insert(dependency.to_owned()) {
                    return Err(ActorError::invalid(
                        "dependsOn entries must be unique per item",
                    ));
                }
                dependency_ids.push(dependency.to_owned());
            }
            graph.push((item_id.to_owned(), dependency_ids));
        }

        let mut indegree: HashMap<String, usize> = HashMap::with_capacity(graph.len());
        let mut dependents: HashMap<String, Vec<String>> = HashMap::new();
        for (item_id, dependencies) in &graph {
            for dependency in dependencies {
                if dependency == item_id {
                    return Err(ActorError::invalid("an item cannot depend on itself"));
                }
                if !ids.contains(dependency) {
                    return Err(ActorError::invalid(format!(
                        "dependency {dependency} does not exist in the graph"
                    )));
                }
                dependents
                    .entry(dependency.clone())
                    .or_default()
                    .push(item_id.clone());
            }
            indegree.insert(item_id.clone(), dependencies.len());
        }
        let mut ready: VecDeque<String> = graph
            .iter()
            .filter(|(_, dependencies)| dependencies.is_empty())
            .map(|(item_id, _)| item_id.clone())
            .collect();
        let mut visited = 0usize;
        while let Some(item_id) = ready.pop_front() {
            visited += 1;
            if let Some(children) = dependents.get(&item_id) {
                for child in children {
                    let remaining = indegree.get_mut(child).ok_or_else(ActorError::internal)?;
                    *remaining -= 1;
                    if *remaining == 0 {
                        ready.push_back(child.clone());
                    }
                }
            }
        }
        if visited != graph.len() {
            return Err(ActorError::invalid(
                "work graph contains a dependency cycle",
            ));
        }

        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let exists: bool = db(transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_graphs WHERE graph_id=?1)",
            [graph_id],
            |row| row.get(0),
        ))?;
        if exists {
            return Err(ActorError::conflict("Work graph already exists"));
        }
        db(transaction.execute("INSERT INTO work_graphs(graph_id) VALUES (?1)", [graph_id]))?;
        for (ordinal, (item_id, _)) in graph.iter().enumerate() {
            db(transaction.execute(
                "INSERT INTO work_items(graph_id,item_id,ordinal,state)
                 VALUES (?1,?2,?3,'pending')",
                params![
                    graph_id,
                    item_id,
                    i64::try_from(ordinal).unwrap_or(i64::MAX)
                ],
            ))?;
        }
        for (item_id, dependencies) in &graph {
            for dependency in dependencies {
                db(transaction.execute(
                    "INSERT INTO work_dependencies(graph_id,item_id,depends_on_item_id)
                     VALUES (?1,?2,?3)",
                    params![graph_id, item_id, dependency],
                ))?;
            }
        }
        db(transaction.commit())?;
        Ok(json!({"schemaVersion":1,"graphId":graph_id,"itemCount":graph.len()}))
    }

    fn work_get_graph(&self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(input, &["graphId"])?;
        let graph_id = required_str(input, "graphId")?;
        let exists: bool = db(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_graphs WHERE graph_id=?1)",
            [graph_id],
            |row| row.get(0),
        ))?;
        if !exists {
            return Ok(Value::Null);
        }
        type WorkGraphRow = (
            String,
            String,
            i64,
            Option<String>,
            Option<i64>,
            i64,
            Option<String>,
        );
        let rows: Vec<WorkGraphRow> = {
            let mut statement = db(self.connection.prepare(
                "SELECT item_id,state,ordinal,owner_id,lease_expires_at,lease_generation,outcome_json
                 FROM work_items WHERE graph_id=?1 ORDER BY ordinal ASC",
            ))?;
            let mapped = db(statement.query_map([graph_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            }))?;
            let mut rows = Vec::new();
            for row in mapped {
                rows.push(db(row)?);
            }
            rows
        };
        let mut items = Vec::with_capacity(rows.len());
        for (item_id, state, ordinal, owner_id, lease_expires_at, generation, outcome) in rows {
            let dependencies: Vec<String> = {
                let mut statement = db(self.connection.prepare(
                    "SELECT d.depends_on_item_id FROM work_dependencies d
                     JOIN work_items dependency
                       ON dependency.graph_id=d.graph_id AND dependency.item_id=d.depends_on_item_id
                     WHERE d.graph_id=?1 AND d.item_id=?2 ORDER BY dependency.ordinal ASC",
                ))?;
                let mapped = db(statement.query_map(params![graph_id, item_id], |row| row.get(0)))?;
                let mut values = Vec::new();
                for row in mapped {
                    values.push(db(row)?);
                }
                values
            };
            let blocked_by: Vec<String> = if state == "blocked" {
                let mut statement = db(self.connection.prepare(
                    "SELECT d.depends_on_item_id FROM work_dependencies d
                     JOIN work_items dependency
                       ON dependency.graph_id=d.graph_id AND dependency.item_id=d.depends_on_item_id
                     WHERE d.graph_id=?1 AND d.item_id=?2
                       AND dependency.state IN ('failed','blocked')
                     ORDER BY dependency.ordinal ASC",
                ))?;
                let mapped = db(statement.query_map(params![graph_id, item_id], |row| row.get(0)))?;
                let mut values = Vec::new();
                for row in mapped {
                    values.push(db(row)?);
                }
                values
            } else {
                Vec::new()
            };
            let outcome = match outcome {
                Some(encoded) => Some(
                    serde_json::from_str::<Value>(&encoded).map_err(|_| ActorError::internal())?,
                ),
                None => None,
            };
            items.push(json!({
                "itemId":item_id,"ordinal":ordinal,"dependsOn":dependencies,"state":state,
                "fencingToken":generation,"ownerId":owner_id,"leaseExpiresAt":lease_expires_at,
                "outcome":outcome,"blockedBy":blocked_by
            }));
        }
        Ok(json!({"schemaVersion":1,"graphId":graph_id,"items":items}))
    }

    fn work_claim(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(input, &["graphId", "ownerId", "now", "leaseMs", "limit"])?;
        let graph_id = required_str(input, "graphId")?;
        let owner_id = required_str(input, "ownerId")?;
        let now = required_non_negative_i64(input, "now")?;
        let lease_ms = required_i64(input, "leaseMs")?;
        if !(1..=86_400_000).contains(&lease_ms) {
            return Err(ActorError::invalid(
                "leaseMs must be between 1 and 86400000",
            ));
        }
        let lease_expires_at = now
            .checked_add(lease_ms)
            .ok_or_else(|| ActorError::invalid("lease deadline overflow"))?;
        let limit = required_i64(input, "limit")?;
        if !(1..=100).contains(&limit) {
            return Err(ActorError::invalid("limit must be between 1 and 100"));
        }
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let exists: bool = db(transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_graphs WHERE graph_id=?1)",
            [graph_id],
            |row| row.get(0),
        ))?;
        if !exists {
            return Err(ActorError::not_found("Work graph does not exist"));
        }
        let rows: Vec<(String, i64)> = {
            let mut statement = db(transaction.prepare(
                "SELECT item.item_id,item.lease_generation FROM work_items item
                 WHERE item.graph_id=?1
                   AND (item.state='pending' OR
                        (item.state='claimed' AND item.lease_expires_at<=?2))
                   AND NOT EXISTS (
                     SELECT 1 FROM work_dependencies dependency
                     JOIN work_items prerequisite
                       ON prerequisite.graph_id=dependency.graph_id
                      AND prerequisite.item_id=dependency.depends_on_item_id
                     WHERE dependency.graph_id=item.graph_id
                       AND dependency.item_id=item.item_id
                       AND prerequisite.state<>'succeeded'
                   )
                 ORDER BY item.ordinal ASC,item.item_id ASC LIMIT ?3",
            ))?;
            let mapped = db(statement.query_map(params![graph_id, now, limit], |row| {
                Ok((row.get(0)?, row.get(1)?))
            }))?;
            let mut rows = Vec::new();
            for row in mapped {
                rows.push(db(row)?);
            }
            rows
        };
        let mut claims = Vec::with_capacity(rows.len());
        for (item_id, generation) in rows {
            let fencing_token = generation
                .checked_add(1)
                .ok_or_else(|| ActorError::conflict("Work fencing generation exhausted"))?;
            let changed = db(transaction.execute(
                "UPDATE work_items
                 SET state='claimed',lease_generation=?3,owner_id=?4,lease_expires_at=?5,outcome_json=NULL
                 WHERE graph_id=?1 AND item_id=?2
                   AND (state='pending' OR (state='claimed' AND lease_expires_at<=?6))",
                params![graph_id, item_id, fencing_token, owner_id, lease_expires_at, now],
            ))?;
            if changed != 1 {
                return Err(ActorError::conflict(
                    "Work claim changed during transaction",
                ));
            }
            claims.push(json!({
                "schemaVersion":1,"graphId":graph_id,"itemId":item_id,"state":"claimed",
                "ownerId":owner_id,"leaseExpiresAt":lease_expires_at,"fencingToken":fencing_token
            }));
        }
        db(transaction.commit())?;
        Ok(Value::Array(claims))
    }

    fn work_heartbeat(&mut self, input: &Value) -> ActorResult<Value> {
        reject_unknown_keys(
            input,
            &[
                "graphId",
                "itemId",
                "ownerId",
                "fencingToken",
                "now",
                "leaseMs",
            ],
        )?;
        let graph_id = required_str(input, "graphId")?;
        let item_id = required_str(input, "itemId")?;
        let owner_id = required_str(input, "ownerId")?;
        let token = required_non_negative_i64(input, "fencingToken")?;
        let now = required_non_negative_i64(input, "now")?;
        let lease_ms = required_i64(input, "leaseMs")?;
        if !(1..=86_400_000).contains(&lease_ms) {
            return Err(ActorError::invalid(
                "leaseMs must be between 1 and 86400000",
            ));
        }
        let lease_expires_at = now
            .checked_add(lease_ms)
            .ok_or_else(|| ActorError::invalid("lease deadline overflow"))?;
        let changed = db(self.connection.execute(
            "UPDATE work_items SET lease_expires_at=?6
             WHERE graph_id=?1 AND item_id=?2 AND state='claimed' AND owner_id=?3
               AND lease_generation=?4 AND lease_expires_at>?5",
            params![graph_id, item_id, owner_id, token, now, lease_expires_at],
        ))?;
        if changed == 0 {
            return Err(ActorError::conflict(
                "Work lease is expired or fencing token is stale",
            ));
        }
        Ok(json!({
            "schemaVersion":1,"graphId":graph_id,"itemId":item_id,"state":"claimed",
            "ownerId":owner_id,"leaseExpiresAt":lease_expires_at,"fencingToken":token
        }))
    }

    fn work_settle(&mut self, input: &Value, terminal: &str) -> ActorResult<Value> {
        reject_unknown_keys(
            input,
            &[
                "graphId",
                "itemId",
                "ownerId",
                "fencingToken",
                "completedAt",
                "outcome",
            ],
        )?;
        let graph_id = required_str(input, "graphId")?;
        let item_id = required_str(input, "itemId")?;
        let owner_id = required_str(input, "ownerId")?;
        let token = required_non_negative_i64(input, "fencingToken")?;
        let completed_at = required_non_negative_i64(input, "completedAt")?;
        let outcome = input
            .get("outcome")
            .ok_or_else(|| ActorError::invalid("outcome is required"))?;
        let encoded = serde_json::to_string(outcome)
            .map_err(|_| ActorError::invalid("outcome is not serializable"))?;
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let changed = db(transaction.execute(
            "UPDATE work_items SET state=?7,owner_id=NULL,lease_expires_at=NULL,outcome_json=?6
             WHERE graph_id=?1 AND item_id=?2 AND state='claimed' AND owner_id=?3
               AND lease_generation=?4 AND lease_expires_at>?5",
            params![
                graph_id,
                item_id,
                owner_id,
                token,
                completed_at,
                encoded,
                terminal
            ],
        ))?;
        if changed == 0 {
            return Err(ActorError::conflict(
                "Work lease is expired or fencing token is stale",
            ));
        }
        if terminal == "failed" {
            let blocked_outcome = serde_json::to_string(&json!({
                "reason":"dependency_failed","failedItemId":item_id
            }))
            .map_err(|_| ActorError::internal())?;
            db(transaction.execute(
                "WITH RECURSIVE descendants(item_id) AS (
                   SELECT item_id FROM work_dependencies
                    WHERE graph_id=?1 AND depends_on_item_id=?2
                   UNION
                   SELECT dependency.item_id FROM work_dependencies dependency
                   JOIN descendants parent ON dependency.depends_on_item_id=parent.item_id
                    WHERE dependency.graph_id=?1
                 )
                 UPDATE work_items
                    SET state='blocked',owner_id=NULL,lease_expires_at=NULL,outcome_json=?3
                  WHERE graph_id=?1 AND item_id IN (SELECT item_id FROM descendants)
                    AND state IN ('pending','claimed')",
                params![graph_id, item_id, blocked_outcome],
            ))?;
        }
        db(transaction.commit())?;
        Ok(json!({
            "schemaVersion":1,"graphId":graph_id,"itemId":item_id,"state":terminal,
            "fencingToken":token,"outcome":outcome
        }))
    }

    fn lifecycle_append(&mut self, input: &Value) -> ActorResult<Value> {
        let stream_id = required_str(input, "streamId")?;
        let event_id = required_str(input, "eventId")?;
        let event = input
            .get("event")
            .ok_or_else(|| ActorError::invalid("event is required"))?;
        let encoded = serde_json::to_string(event)
            .map_err(|_| ActorError::invalid("event is not serializable"))?;
        let transaction = db(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate))?;
        let existing: Option<(i64, String)> = db(transaction.query_row(
            "SELECT sequence, event_json FROM lifecycle_events WHERE stream_id = ?1 AND event_id = ?2",
            params![stream_id, event_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional())?;
        if let Some((sequence, prior)) = existing {
            if prior != encoded {
                return Err(ActorError::conflict(
                    "Lifecycle event identity has different content",
                ));
            }
            db(transaction.commit())?;
            return Ok(json!({"sequence":sequence,"appended":false}));
        }
        let sequence: i64 = db(transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM lifecycle_events WHERE stream_id = ?1",
            [stream_id],
            |row| row.get(0),
        ))?;
        db(transaction.execute(
            "INSERT INTO lifecycle_events(stream_id, sequence, event_id, event_json) VALUES (?1, ?2, ?3, ?4)",
            params![stream_id, sequence, event_id, encoded],
        ))?;
        db(transaction.commit())?;
        Ok(json!({"sequence":sequence,"appended":true}))
    }

    fn lifecycle_list(&self, input: &Value) -> ActorResult<Value> {
        let stream_id = required_str(input, "streamId")?;
        let after = required_i64(input, "afterSequence")?;
        let limit = required_i64(input, "limit")?;
        if after < 0 {
            return Err(ActorError::invalid("afterSequence must be non-negative"));
        }
        if !(1..=1000).contains(&limit) {
            return Err(ActorError::invalid("limit must be between 1 and 1000"));
        }
        let mut statement = db(self.connection.prepare(
            "SELECT sequence, event_id, event_json FROM lifecycle_events
             WHERE stream_id = ?1 AND sequence > ?2 ORDER BY sequence ASC LIMIT ?3",
        ))?;
        let mapped = db(
            statement.query_map(params![stream_id, after, limit], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }),
        )?;
        let mut events = Vec::new();
        for row in mapped {
            let (sequence, event_id, encoded) = db(row)?;
            let event: Value =
                serde_json::from_str(&encoded).map_err(|_| ActorError::internal())?;
            events.push(json!({"sequence":sequence,"eventId":event_id,"event":event}));
        }
        Ok(Value::Array(events))
    }
}

pub fn parse_request(line: &str) -> ActorResult<Request> {
    let request: Request = serde_json::from_str(line)
        .map_err(|_| ActorError::invalid("Request must be valid JSON"))?;
    if request.schema_version != PROTOCOL_VERSION {
        return Err(ActorError::invalid("Unsupported schemaVersion"));
    }
    if request.id.is_null() {
        return Err(ActorError::invalid("id is required"));
    }
    if request.method.is_empty() {
        return Err(ActorError::invalid("method must be a non-empty string"));
    }
    if !request.params.is_object() {
        return Err(ActorError::invalid("params must be an object"));
    }
    Ok(request)
}

pub fn invalid_response(id: Value, error: ActorError) -> Response {
    Response::Err {
        schema_version: PROTOCOL_VERSION,
        id,
        ok: false,
        error: ErrorBody {
            code: error.code,
            message: error.message,
        },
    }
}

pub fn frame_too_large_response() -> Response {
    Response::Err {
        schema_version: PROTOCOL_VERSION,
        id: Value::Null,
        ok: false,
        error: ErrorBody {
            code: "FRAME_TOO_LARGE",
            message: "Request frame exceeds the protocol limit".into(),
        },
    }
}

pub fn response_too_large_response() -> Response {
    Response::Err {
        schema_version: PROTOCOL_VERSION,
        id: Value::Null,
        ok: false,
        error: ErrorBody {
            code: "FRAME_TOO_LARGE",
            message: "Response frame exceeds the protocol limit".into(),
        },
    }
}

pub fn malformed_request_response(message: impl Into<String>) -> Response {
    invalid_response(Value::Null, ActorError::invalid(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn request(id: i64, method: &str, params: Value) -> Request {
        Request {
            schema_version: PROTOCOL_VERSION,
            id: json!(id),
            method: method.into(),
            params,
        }
    }

    fn result(actor: &mut Actor, method: &str, params: Value) -> Value {
        match actor.handle(request(1, method, params)) {
            Response::Ok { result, .. } => result,
            Response::Err { error, .. } => panic!("{}: {}", error.code, error.message),
        }
    }

    #[test]
    fn session_cas_replay_and_restart_are_durable() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let mut actor = Actor::open(&path).unwrap();
        assert_eq!(
            result(
                &mut actor,
                "session.append",
                json!({
                    "sessionId":"s","expectedRevision":"0","events":[{"n":1},{"n":2}],
                    "index":{"cwd":"/workspace","parentSessionId":"parent","updatedAt":20}
                })
            ),
            json!({"revision":"2"})
        );
        assert_eq!(
            result(
                &mut actor,
                "session.list",
                json!({"cwd":"/workspace","limit":10})
            ),
            json!([{
                "sessionId":"s","revision":"2","cwd":"/workspace","parentSessionId":"parent","updatedAt":20
            }])
        );
        match actor.handle(request(
            2,
            "session.append",
            json!({"sessionId":"s","expectedRevision":"0","events":[{"n":3}]}),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("stale CAS succeeded"),
        }
        drop(actor);
        let mut actor = Actor::open(&path).unwrap();
        assert_eq!(
            result(&mut actor, "session.load", json!({"sessionId":"s"})),
            json!({"sessionId":"s","revision":"2","events":[{"n":1},{"n":2}]})
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn loading_an_unknown_session_returns_null() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        assert_eq!(
            result(&mut actor, "session.load", json!({"sessionId":"missing"}),),
            Value::Null,
        );
    }

    #[test]
    fn session_load_page_is_byte_bounded_ordered_and_cursor_strict() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        result(
            &mut actor,
            "session.append",
            json!({
                "sessionId":"s",
                "expectedRevision":"0",
                "events":[{"n":1,"text":"first"},{"n":2,"text":"second"},{"n":3,"text":"third"}]
            }),
        );
        let expected_first = json!({
            "sessionId":"s",
            "revision":"3",
            "afterSequence":null,
            "events":[{"sequence":"1","event":{"n":1,"text":"first"}}],
            "nextCursor":"1",
            "done":false
        });
        let exact_first_bytes = serde_json::to_vec(&expected_first).unwrap().len();
        let first = result(
            &mut actor,
            "session.loadPage",
            json!({
                "sessionId":"s",
                "afterSequence":null,
                "expectedRevision":null,
                "maxEvents":3,
                "maxBytes":exact_first_bytes
            }),
        );
        assert_eq!(first, expected_first);
        assert_eq!(serde_json::to_vec(&first).unwrap().len(), exact_first_bytes);

        assert_eq!(
            result(
                &mut actor,
                "session.loadPage",
                json!({
                    "sessionId":"s",
                    "afterSequence":"1",
                    "expectedRevision":"3",
                    "maxEvents":2,
                    "maxBytes":4096
                })
            ),
            json!({
                "sessionId":"s",
                "revision":"3",
                "afterSequence":"1",
                "events":[
                    {"sequence":"2","event":{"n":2,"text":"second"}},
                    {"sequence":"3","event":{"n":3,"text":"third"}}
                ],
                "nextCursor":null,
                "done":true
            })
        );

        for params in [
            json!({"sessionId":"s","afterSequence":"01","expectedRevision":"3","maxEvents":1,"maxBytes":4096}),
            json!({"sessionId":"s","afterSequence":"4","expectedRevision":"3","maxEvents":1,"maxBytes":4096}),
            json!({"sessionId":"s","afterSequence":null,"expectedRevision":null,"maxEvents":0,"maxBytes":4096}),
            json!({"sessionId":"s","afterSequence":null,"expectedRevision":null,"maxEvents":1,"maxBytes":127}),
        ] {
            match actor.handle(request(7, "session.loadPage", params)) {
                Response::Err { error, .. } => assert_eq!(error.code, "INVALID_REQUEST"),
                _ => panic!("invalid session page request succeeded"),
            }
        }
        match actor.handle(request(
            8,
            "session.loadPage",
            json!({
                "sessionId":"s","afterSequence":"1","expectedRevision":"2","maxEvents":1,"maxBytes":4096
            }),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("stale session page revision succeeded"),
        }
    }

    #[test]
    fn session_load_page_rejects_an_event_that_cannot_fit_its_byte_budget() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        result(
            &mut actor,
            "session.append",
            json!({
                "sessionId":"s",
                "expectedRevision":"0",
                "events":[{"text":"x".repeat(1024)}]
            }),
        );
        match actor.handle(request(
            9,
            "session.loadPage",
            json!({
                "sessionId":"s","afterSequence":null,"expectedRevision":null,"maxEvents":1,"maxBytes":128
            }),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "FRAME_TOO_LARGE"),
            _ => panic!("oversized session event was returned"),
        }
    }

    #[test]
    fn session_list_uses_the_navigation_index() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        result(
            &mut actor,
            "session.append",
            json!({
                "sessionId":"indexed","expectedRevision":"0","events":[{"n":1}],
                "index":{"cwd":"/workspace","updatedAt":10}
            }),
        );
        let mut statement = actor
            .connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT session_id, revision, parent_session_id, updated_at FROM sessions
                 WHERE cwd = ?1 AND revision > 0
                 ORDER BY updated_at DESC, session_id ASC LIMIT ?2",
            )
            .unwrap();
        let details = statement
            .query_map(params!["/workspace", 10], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("sessions_navigation_idx")),
            "query plan did not use sessions_navigation_idx: {details:?}"
        );
    }

    #[test]
    fn version_one_database_migrates_through_every_schema_step() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r#"CREATE TABLE sessions (
                   session_id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0)
                 );
                 CREATE TABLE session_events (
                   session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                   sequence INTEGER NOT NULL,
                   event_json TEXT NOT NULL,
                   PRIMARY KEY (session_id, sequence)
                 );
                  CREATE TABLE effects (
                    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                    effect_key TEXT NOT NULL,
                    state TEXT NOT NULL,
                    receipt_json TEXT NOT NULL,
                    PRIMARY KEY (session_id, effect_key)
                  );
                  CREATE TABLE communications (
                    channel TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    available_at INTEGER NOT NULL,
                    lease_consumer TEXT,
                    lease_until INTEGER,
                    PRIMARY KEY (channel, message_id),
                    CHECK ((lease_consumer IS NULL) = (lease_until IS NULL))
                  );
                 INSERT INTO sessions(session_id, revision) VALUES ('migrated-v1', 1);
                 INSERT INTO session_events(session_id, sequence, event_json) VALUES (
                   'migrated-v1', 1,
                   '{"timestamp":10,"event":{"type":"custom.appended","kind":"session.cwd","value":"/workspace-v1"}}'
                 );
                 PRAGMA user_version = 1;"#,
            )
            .unwrap();
        drop(connection);

        let mut connection = Connection::open(&path).unwrap();
        for expected in 1..DATABASE_SCHEMA_VERSION {
            assert_eq!(
                migrate_one(&mut connection, expected).unwrap(),
                expected + 1
            );
            assert_eq!(database_version(&connection).unwrap(), expected + 1);
        }
        drop(connection);

        let mut actor = Actor::open(&path).unwrap();
        let version: i64 = actor
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert_eq!(
            result(
                &mut actor,
                "session.list",
                json!({"cwd":"/workspace-v1","limit":10}),
            )[0]["sessionId"],
            json!("migrated-v1"),
        );
        assert_automation_ledger_is_usable(&mut actor, "migrated-v1-automation");
    }

    #[test]
    fn version_two_database_migrates_session_index_transactionally() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            r#"CREATE TABLE sessions (
               session_id TEXT PRIMARY KEY,
               revision INTEGER NOT NULL CHECK (revision >= 0)
             );
              CREATE TABLE session_events (
               session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
               sequence INTEGER NOT NULL,
               event_json TEXT NOT NULL,
                PRIMARY KEY (session_id, sequence)
              );
              CREATE TABLE communications (
                channel TEXT NOT NULL,
                message_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                available_at INTEGER NOT NULL,
                lease_consumer TEXT,
                lease_until INTEGER,
                PRIMARY KEY (channel, message_id),
                CHECK ((lease_consumer IS NULL) = (lease_until IS NULL))
              );
             INSERT INTO sessions(session_id, revision) VALUES ('migrated', 1);
             INSERT INTO session_events(session_id, sequence, event_json) VALUES (
               'migrated', 1,
               '{"timestamp":10,"event":{"type":"custom.appended","kind":"session.cwd","value":"/workspace"}}'
             );
             PRAGMA user_version = 2;"#,
        ).unwrap();
        drop(connection);

        let mut connection = Connection::open(&path).unwrap();
        for expected in 2..DATABASE_SCHEMA_VERSION {
            assert_eq!(
                migrate_one(&mut connection, expected).unwrap(),
                expected + 1
            );
            assert_eq!(database_version(&connection).unwrap(), expected + 1);
        }
        drop(connection);

        let mut actor = Actor::open(&path).unwrap();
        let version: i64 = actor
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert_eq!(
            result(
                &mut actor,
                "session.list",
                json!({"cwd":"/workspace","limit":10})
            )[0]["sessionId"],
            json!("migrated")
        );
        assert_automation_ledger_is_usable(&mut actor, "migrated-v2-automation");
        assert_eq!(
            result(
                &mut actor,
                "session.append",
                json!({
                    "sessionId":"migrated","expectedRevision":"1","events":[{"n":2}],
                    "index":{"cwd":"/workspace","updatedAt":20}
                })
            ),
            json!({"revision":"2"})
        );
        assert_eq!(
            result(
                &mut actor,
                "session.list",
                json!({"cwd":"/workspace","limit":10})
            )[0]["sessionId"],
            json!("migrated")
        );
    }

    #[test]
    fn version_three_database_adds_automation_ledger_transactionally() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE marker(value TEXT);
                 CREATE TABLE sessions (
                   session_id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0),
                   cwd TEXT,
                   parent_session_id TEXT,
                   updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
                 );
                 CREATE TABLE communications (
                   channel TEXT NOT NULL,
                   message_id TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   available_at INTEGER NOT NULL,
                   lease_consumer TEXT,
                   lease_until INTEGER,
                   PRIMARY KEY (channel, message_id),
                   CHECK ((lease_consumer IS NULL) = (lease_until IS NULL))
                 );
                 PRAGMA user_version = 3;",
            )
            .unwrap();
        drop(connection);

        let actor = Actor::open(&path).unwrap();
        let version: i64 = actor
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        let tables: i64 = actor
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN ('automations', 'automation_runs')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
    }

    #[test]
    fn effect_replay_and_terminal_settlement_are_idempotent() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        result(
            &mut actor,
            "session.append",
            json!({"sessionId":"s","expectedRevision":"0","events":[]}),
        );
        let receipt = json!({"operation":"write","hash":"abc"});
        assert_eq!(
            result(
                &mut actor,
                "effect.begin",
                json!({"sessionId":"s","key":"k","receipt":receipt})
            ),
            json!("acquired")
        );
        assert_eq!(
            result(
                &mut actor,
                "effect.begin",
                json!({"sessionId":"s","key":"k","receipt":receipt})
            ),
            json!("started")
        );
        assert_eq!(
            result(
                &mut actor,
                "effect.begin",
                json!({"sessionId":"s","key":"k","receipt":{"operation":"other"}})
            ),
            json!("mismatch")
        );
        assert_eq!(
            result(
                &mut actor,
                "effect.settle",
                json!({"sessionId":"s","key":"k","state":"committed"})
            ),
            json!("committed")
        );
        assert_eq!(
            result(
                &mut actor,
                "effect.settle",
                json!({"sessionId":"s","key":"k","state":"committed"})
            ),
            json!("committed")
        );
        match actor.handle(request(
            3,
            "effect.settle",
            json!({"sessionId":"s","key":"k","state":"failed"}),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("conflicting terminal transition succeeded"),
        }
    }

    #[test]
    fn communication_claim_lease_ack_release_and_restart() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let mut actor = Actor::open(&path).unwrap();
        for (id, at) in [("later", 20), ("first", 10), ("second", 10)] {
            result(
                &mut actor,
                "communication.enqueue",
                json!({"channel":"c","messageId":id,"payload":{"id":id},"availableAt":at}),
            );
        }
        let claimed = result(
            &mut actor,
            "communication.claim",
            json!({"channel":"c","consumerId":"a","now":10,"leaseMs":5,"limit":2}),
        );
        assert_eq!(
            claimed
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["messageId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        let first_generation = claimed[0]["leaseGeneration"].as_i64().unwrap();
        assert_eq!(
            result(
                &mut actor,
                "communication.claim",
                json!({"channel":"c","consumerId":"b","now":10,"leaseMs":5,"limit":2})
            ),
            json!([])
        );
        result(
            &mut actor,
            "communication.release",
            json!({
                "channel":"c","messageId":"first","consumerId":"a",
                "leaseGeneration":first_generation
            }),
        );
        let reclaimed_first = result(
            &mut actor,
            "communication.claim",
            json!({"channel":"c","consumerId":"b","now":10,"leaseMs":5,"limit":1}),
        );
        assert_eq!(reclaimed_first[0]["messageId"], json!("first"));
        let reclaimed_generation = reclaimed_first[0]["leaseGeneration"].as_i64().unwrap();
        result(
            &mut actor,
            "communication.ack",
            json!({
                "channel":"c","messageId":"first","consumerId":"b",
                "leaseGeneration":reclaimed_generation
            }),
        );
        drop(actor);
        let mut actor = Actor::open(&path).unwrap();
        let reclaimed = result(
            &mut actor,
            "communication.claim",
            json!({"channel":"c","consumerId":"b","now":15,"leaseMs":5,"limit":10}),
        );
        assert_eq!(
            reclaimed
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["messageId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["second"]
        );
    }

    #[test]
    fn communication_fencing_rejects_stale_same_consumer_ack_and_release() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        result(
            &mut actor,
            "communication.enqueue",
            json!({"channel":"c","messageId":"m","payload":{"n":1},"availableAt":0}),
        );
        let first = result(
            &mut actor,
            "communication.claim",
            json!({"channel":"c","consumerId":"same","now":0,"leaseMs":5,"limit":1}),
        );
        let first_generation = first[0]["leaseGeneration"].as_i64().unwrap();
        let second = result(
            &mut actor,
            "communication.claim",
            json!({"channel":"c","consumerId":"same","now":5,"leaseMs":5,"limit":1}),
        );
        let second_generation = second[0]["leaseGeneration"].as_i64().unwrap();
        assert_eq!(second_generation, first_generation + 1);

        for (method, label) in [
            ("communication.ack", "stale acknowledgement"),
            ("communication.release", "stale release"),
        ] {
            match actor.handle(request(
                7,
                method,
                json!({
                    "channel":"c","messageId":"m","consumerId":"same",
                    "leaseGeneration":first_generation
                }),
            )) {
                Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
                _ => panic!("{label} affected the newer lease"),
            }
        }
        assert_eq!(
            result(
                &mut actor,
                "communication.claim",
                json!({"channel":"c","consumerId":"other","now":6,"leaseMs":5,"limit":1})
            ),
            json!([]),
        );
        result(
            &mut actor,
            "communication.ack",
            json!({
                "channel":"c","messageId":"m","consumerId":"same",
                "leaseGeneration":second_generation
            }),
        );
    }

    #[test]
    fn communication_receipts_require_a_fencing_generation() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        result(
            &mut actor,
            "communication.enqueue",
            json!({"channel":"c","messageId":"m","payload":{},"availableAt":0}),
        );
        result(
            &mut actor,
            "communication.claim",
            json!({"channel":"c","consumerId":"worker","now":0,"leaseMs":5,"limit":1}),
        );
        for method in ["communication.ack", "communication.release"] {
            match actor.handle(request(
                8,
                method,
                json!({"channel":"c","messageId":"m","consumerId":"worker"}),
            )) {
                Response::Err { error, .. } => assert_eq!(error.code, "INVALID_REQUEST"),
                _ => panic!("receipt without a fencing generation succeeded"),
            }
        }
    }

    #[test]
    fn communication_abandon_prefix_is_bounded_ordered_and_settles_leased_rows() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        for (channel, id) in [
            ("worker-input:session-1:worker-b:r2", "r2"),
            ("worker-input:session-1:worker-a:r1", "r1"),
            ("worker-input:session-2:worker-c:r3", "r3"),
        ] {
            result(
                &mut actor,
                "communication.enqueue",
                json!({"channel":channel,"messageId":id,"payload":{},"availableAt":0}),
            );
        }
        result(
            &mut actor,
            "communication.claim",
            json!({
                "channel":"worker-input:session-1:worker-a:r1",
                "consumerId":"crashed-parent","now":0,"leaseMs":10_000,"limit":1
            }),
        );

        assert_eq!(
            result(
                &mut actor,
                "communication.abandonPrefix",
                json!({"channelPrefix":"worker-input:session-1:","limit":1}),
            ),
            json!([{"channel":"worker-input:session-1:worker-a:r1","messageId":"r1"}]),
        );
        assert_eq!(
            result(
                &mut actor,
                "communication.abandonPrefix",
                json!({"channelPrefix":"worker-input:session-1:","limit":1000}),
            ),
            json!([{"channel":"worker-input:session-1:worker-b:r2","messageId":"r2"}]),
        );
        assert_eq!(
            result(
                &mut actor,
                "communication.abandonPrefix",
                json!({"channelPrefix":"worker-input:session-1:","limit":1000}),
            ),
            json!([]),
        );
        assert_eq!(
            result(
                &mut actor,
                "communication.claim",
                json!({
                    "channel":"worker-input:session-2:worker-c:r3",
                    "consumerId":"live-parent","now":0,"leaseMs":10,"limit":1
                }),
            )[0]["messageId"],
            json!("r3"),
        );
    }

    #[test]
    fn settings_are_revisioned_by_scope_and_survive_restart() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let mut actor = Actor::open(&path).unwrap();
        assert_eq!(
            result(&mut actor, "settings.get", json!({"scope":"global"})),
            json!({"revision":"0","values":{}})
        );
        assert_eq!(
            result(
                &mut actor,
                "settings.compareAndSet",
                json!({"scope":"global","expectedRevision":"0","values":{"theme":"dark"}})
            ),
            json!({"revision":"1"})
        );
        match actor.handle(request(
            4,
            "settings.compareAndSet",
            json!({"scope":"global","expectedRevision":"0","values":{"theme":"light"}}),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("stale settings CAS succeeded"),
        }
        drop(actor);
        let mut actor = Actor::open(&path).unwrap();
        assert_eq!(
            result(&mut actor, "settings.get", json!({"scope":"global"})),
            json!({"revision":"1","values":{"theme":"dark"}})
        );
    }

    #[test]
    fn lifecycle_append_is_idempotent_and_list_is_ordered_and_bounded() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        assert_eq!(
            result(
                &mut actor,
                "lifecycle.append",
                json!({"streamId":"s","eventId":"b","event":{"n":2}})
            ),
            json!({"sequence":1,"appended":true})
        );
        assert_eq!(
            result(
                &mut actor,
                "lifecycle.append",
                json!({"streamId":"s","eventId":"b","event":{"n":2}})
            ),
            json!({"sequence":1,"appended":false})
        );
        assert_eq!(
            result(
                &mut actor,
                "lifecycle.append",
                json!({"streamId":"s","eventId":"a","event":{"n":1}})
            ),
            json!({"sequence":2,"appended":true})
        );
        match actor.handle(request(
            5,
            "lifecycle.append",
            json!({"streamId":"s","eventId":"b","event":{"n":99}}),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("duplicate lifecycle identity changed content"),
        }
        assert_eq!(
            result(
                &mut actor,
                "lifecycle.list",
                json!({"streamId":"s","afterSequence":0,"limit":1})
            ),
            json!([{"sequence":1,"eventId":"b","event":{"n":2}}])
        );
        assert_eq!(
            result(
                &mut actor,
                "lifecycle.list",
                json!({"streamId":"s","afterSequence":1,"limit":10})
            ),
            json!([{"sequence":2,"eventId":"a","event":{"n":1}}])
        );
    }

    fn definition(id: &str, revision: i64, state: &str, schedule: Value) -> Value {
        json!({
            "schemaVersion":1,"id":id,"revision":revision,"state":state,
            "schedule":schedule,"misfirePolicy":"run-once",
            "retryPolicy":{"maxAttempts":3,"backoffMs":1000},
            "action":{"name":"awareness.status","version":1,"payload":{"workspace":"/workspace"}},
            "createdAt":10,"updatedAt":10 + revision
        })
    }

    fn put_automation(actor: &mut Actor, definition: Value) -> Value {
        result(actor, "automation.put", definition)
    }

    fn assert_automation_ledger_is_usable(actor: &mut Actor, automation_id: &str) {
        let stored = definition(automation_id, 0, "active", json!({"kind":"once","at":50}));
        assert_eq!(put_automation(actor, stored.clone()), stored);
        assert_eq!(
            result(
                actor,
                "automation.list",
                json!({"limit":10,"states":["active"]}),
            )[0]["id"],
            json!(automation_id),
        );
        assert_eq!(
            result(
                actor,
                "automation.claim",
                json!({
                    "ownerId":"migration-test","now":50,"leaseMs":10,"limit":1,
                    "candidates":[{"automationId":automation_id,"scheduledFor":50}]
                }),
            )[0]["automationId"],
            json!(automation_id),
        );
    }

    #[test]
    fn automation_definitions_match_core_shape_and_use_revision_cas() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        let initial = definition("status", 0, "active", json!({"kind":"once","at":20}));
        assert_eq!(put_automation(&mut actor, initial.clone()), initial);
        assert_eq!(
            result(
                &mut actor,
                "automation.list",
                json!({"limit":10,"states":["active"]})
            ),
            json!([initial]),
        );
        match actor.handle(request(2, "automation.put", initial)) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("stale automation put succeeded"),
        }
        let updated = definition(
            "status",
            1,
            "active",
            json!({"kind":"interval","everyMs":60000,"anchorAt":10}),
        );
        assert_eq!(put_automation(&mut actor, updated.clone()), updated);
        let cancelled = result(
            &mut actor,
            "automation.cancel",
            json!({"id":"status","expectedRevision":1,"cancelledAt":20}),
        );
        assert_eq!(cancelled["revision"], json!(2));
        assert_eq!(cancelled["state"], json!("cancelled"));
        assert_eq!(cancelled["createdAt"], json!(10));
        assert_eq!(cancelled["updatedAt"], json!(20));
        match actor.handle(request(
            3,
            "automation.cancel",
            json!({"id":"status","expectedRevision":1,"cancelledAt":21}),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("stale automation cancellation succeeded"),
        }
    }

    #[test]
    fn cancellation_returns_the_exact_target_with_multiple_cancelled_definitions() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        for id in ["a-first", "z-target"] {
            put_automation(
                &mut actor,
                definition(id, 0, "active", json!({"kind":"once","at":20})),
            );
        }
        result(
            &mut actor,
            "automation.cancel",
            json!({"id":"a-first","expectedRevision":0,"cancelledAt":20}),
        );
        let target = result(
            &mut actor,
            "automation.cancel",
            json!({"id":"z-target","expectedRevision":0,"cancelledAt":21}),
        );
        assert_eq!(target["id"], json!("z-target"));
        assert_eq!(target["revision"], json!(1));
        assert_eq!(target["updatedAt"], json!(21));
    }

    #[test]
    fn automation_schedule_action_and_misfire_shapes_are_exact() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        for (id, schedule) in [
            ("once", json!({"kind":"once","at":20})),
            (
                "interval",
                json!({"kind":"interval","everyMs":5,"anchorAt":20}),
            ),
            (
                "cron",
                json!({"kind":"cron","expression":"0 * * * *","timeZone":"UTC"}),
            ),
        ] {
            let stored = put_automation(&mut actor, definition(id, 0, "active", schedule.clone()));
            assert_eq!(stored["schedule"], schedule);
            assert_eq!(
                stored["retryPolicy"],
                json!({"maxAttempts":3,"backoffMs":1000})
            );
            assert_eq!(
                stored["action"],
                json!({"name":"awareness.status","version":1,"payload":{"workspace":"/workspace"}})
            );
        }
        let mut invalid = vec![
            definition("bad-once", 0, "active", json!({"kind":"once","at":-1})),
            definition(
                "bad-interval",
                0,
                "active",
                json!({"kind":"interval","everyMs":0,"anchorAt":0}),
            ),
            definition(
                "bad-cron",
                0,
                "active",
                json!({"kind":"cron","expression":"","timeZone":"UTC"}),
            ),
            definition(
                "extra",
                0,
                "active",
                json!({"kind":"once","at":1,"extra":true}),
            ),
        ];
        let mut bad_action = definition("bad-action", 0, "active", json!({"kind":"once","at":1}));
        bad_action["action"] = json!({"kind":"shell","params":{}});
        invalid.push(bad_action);
        let mut bad_misfire = definition("bad-misfire", 0, "active", json!({"kind":"once","at":1}));
        bad_misfire["misfirePolicy"] = json!("maybe");
        invalid.push(bad_misfire);
        let mut bad_attempts =
            definition("bad-attempts", 0, "active", json!({"kind":"once","at":1}));
        bad_attempts["retryPolicy"]["maxAttempts"] = json!(101);
        invalid.push(bad_attempts);
        let mut bad_backoff = definition("bad-backoff", 0, "active", json!({"kind":"once","at":1}));
        bad_backoff["retryPolicy"]["backoffMs"] = json!(-1);
        invalid.push(bad_backoff);
        for definition in invalid {
            match actor.handle(request(4, "automation.put", definition)) {
                Response::Err { error, .. } => assert_eq!(error.code, "INVALID_REQUEST"),
                _ => panic!("invalid automation definition succeeded"),
            }
        }
    }

    #[test]
    fn deterministic_candidates_are_atomically_deduplicated_leased_and_fenced() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        put_automation(
            &mut actor,
            definition("status", 0, "active", json!({"kind":"once","at":50})),
        );
        let candidates = json!([{"automationId":"status","scheduledFor":50}]);
        let first = result(
            &mut actor,
            "automation.claim",
            json!({"ownerId":"one","now":100,"leaseMs":10,"limit":1,"candidates":candidates}),
        );
        assert_eq!(first[0]["schemaVersion"], json!(1));
        assert_eq!(first[0]["state"], json!("claimed"));
        assert_eq!(first[0]["scheduledFor"], json!(50));
        assert_eq!(first[0]["ownerId"], json!("one"));
        assert!(first[0].get("retryPolicy").is_none());
        assert!(first[0]["fencingToken"].as_i64().is_some());
        let first_token = first[0]["fencingToken"].as_i64().unwrap();
        let run_id = first[0]["runId"].as_str().unwrap().to_owned();
        assert_eq!(
            result(
                &mut actor,
                "automation.claim",
                json!({"ownerId":"two","now":105,"leaseMs":10,"limit":1,"candidates":candidates}),
            ),
            json!([]),
        );
        let second = result(
            &mut actor,
            "automation.claim",
            json!({"ownerId":"two","now":110,"leaseMs":10,"limit":1,"candidates":candidates}),
        );
        let second_token = second[0]["fencingToken"].as_i64().unwrap();
        assert_eq!(second_token, first_token + 1);
        match actor.handle(request(
            5,
            "automation.heartbeat",
            json!({"runId":run_id,"ownerId":"one","fencingToken":first_token,"now":111,"leaseMs":10}),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
            _ => panic!("stale fencing token succeeded"),
        }
        let heartbeat = result(
            &mut actor,
            "automation.heartbeat",
            json!({"runId":run_id,"ownerId":"two","fencingToken":second_token,"now":111,"leaseMs":10}),
        );
        assert_eq!(heartbeat["leaseExpiresAt"], json!(121));
        let completed = result(
            &mut actor,
            "automation.complete",
            json!({
                "runId":run_id,"ownerId":"two","fencingToken":second_token,
                "outcome":{"state":"succeeded","completedAt":112,"result":{"ok":true}}
            }),
        );
        assert_eq!(completed["state"], json!("succeeded"));
        assert_eq!(completed["outcome"]["result"], json!({"ok":true}));
        assert_eq!(
            result(
                &mut actor,
                "automation.claim",
                json!({"ownerId":"three","now":200,"leaseMs":10,"limit":1,"candidates":candidates}),
            ),
            json!([]),
        );
    }

    #[test]
    fn uncertain_outcomes_are_terminal_and_claim_inputs_are_bounded() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        put_automation(
            &mut actor,
            definition("ambiguous", 0, "active", json!({"kind":"once","at":10})),
        );
        let candidates = json!([{"automationId":"ambiguous","scheduledFor":10}]);
        let claim = result(
            &mut actor,
            "automation.claim",
            json!({"ownerId":"one","now":10,"leaseMs":10,"limit":1,"candidates":candidates}),
        );
        let sealed = result(
            &mut actor,
            "automation.uncertain",
            json!({
                "runId":claim[0]["runId"],"ownerId":"one","fencingToken":claim[0]["fencingToken"],
                "outcome":{"state":"uncertain","completedAt":11,"reason":"transport lost"}
            }),
        );
        assert_eq!(sealed["state"], json!("uncertain"));
        assert_eq!(
            result(
                &mut actor,
                "automation.claim",
                json!({"ownerId":"two","now":100,"leaseMs":10,"limit":1,"candidates":candidates}),
            ),
            json!([]),
        );
        for params in [
            json!({"ownerId":"c","now":0,"leaseMs":1,"limit":101,"candidates":[]}),
            json!({"ownerId":"c","now":0,"leaseMs":0,"limit":1,"candidates":[]}),
            json!({"ownerId":"c","now":0,"leaseMs":1,"limit":1,"candidates":[]}),
            json!({"ownerId":"c","now":0,"leaseMs":1,"limit":1,"candidates":[
                {"automationId":"ambiguous","scheduledFor":10},
                {"automationId":"ambiguous","scheduledFor":11}
            ]}),
        ] {
            match actor.handle(request(6, "automation.claim", params)) {
                Response::Err { error, .. } => assert_eq!(error.code, "INVALID_REQUEST"),
                _ => panic!("invalid automation claim succeeded"),
            }
        }
    }

    #[test]
    fn dependency_work_claims_only_ready_items_and_reconciles_failed_branches() {
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        result(
            &mut actor,
            "work.putGraph",
            json!({
                "graphId":"release",
                "items":[
                    {"itemId":"root","dependsOn":[]},
                    {"itemId":"left","dependsOn":["root"]},
                    {"itemId":"right","dependsOn":["root"]},
                    {"itemId":"join","dependsOn":["left","right"]}
                ]
            }),
        );

        let first = result(
            &mut actor,
            "work.claim",
            json!({"graphId":"release","ownerId":"one","now":10,"leaseMs":10,"limit":10}),
        );
        assert_eq!(first.as_array().unwrap().len(), 1);
        assert_eq!(first[0]["itemId"], json!("root"));
        result(
            &mut actor,
            "work.complete",
            json!({
                "graphId":"release","itemId":"root","ownerId":"one",
                "fencingToken":first[0]["fencingToken"],"completedAt":11,
                "outcome":{"ok":true}
            }),
        );

        let parallel = result(
            &mut actor,
            "work.claim",
            json!({"graphId":"release","ownerId":"two","now":12,"leaseMs":10,"limit":10}),
        );
        assert_eq!(parallel.as_array().unwrap().len(), 2);
        assert_eq!(parallel[0]["itemId"], json!("left"));
        assert_eq!(parallel[1]["itemId"], json!("right"));
        result(
            &mut actor,
            "work.fail",
            json!({
                "graphId":"release","itemId":"left","ownerId":"two",
                "fencingToken":parallel[0]["fencingToken"],"completedAt":13,
                "outcome":{"code":"TEST_FAILED"}
            }),
        );
        result(
            &mut actor,
            "work.complete",
            json!({
                "graphId":"release","itemId":"right","ownerId":"two",
                "fencingToken":parallel[1]["fencingToken"],"completedAt":13,
                "outcome":{"ok":true}
            }),
        );

        assert_eq!(
            result(
                &mut actor,
                "work.claim",
                json!({"graphId":"release","ownerId":"three","now":20,"leaseMs":10,"limit":10}),
            ),
            json!([]),
        );
        let graph = result(&mut actor, "work.getGraph", json!({"graphId":"release"}));
        assert_eq!(graph["items"][3]["itemId"], json!("join"));
        assert_eq!(graph["items"][3]["state"], json!("blocked"));
        assert_eq!(graph["items"][3]["blockedBy"], json!(["left"]));
    }

    #[test]
    fn dependency_work_leases_are_durable_fenced_and_graph_writes_are_atomic() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let mut actor = Actor::open(&path).unwrap();
        for items in [
            json!([{"itemId":"a","dependsOn":["missing"]}]),
            json!([
                {"itemId":"a","dependsOn":["b"]},
                {"itemId":"b","dependsOn":["a"]}
            ]),
        ] {
            match actor.handle(request(
                1,
                "work.putGraph",
                json!({"graphId":"invalid","items":items}),
            )) {
                Response::Err { error, .. } => assert_eq!(error.code, "INVALID_REQUEST"),
                _ => panic!("invalid dependency graph succeeded"),
            }
        }
        assert_eq!(
            result(&mut actor, "work.getGraph", json!({"graphId":"invalid"}),),
            Value::Null,
        );
        result(
            &mut actor,
            "work.putGraph",
            json!({"graphId":"durable","items":[{"itemId":"only","dependsOn":[]}]}),
        );
        let first = result(
            &mut actor,
            "work.claim",
            json!({"graphId":"durable","ownerId":"one","now":10,"leaseMs":10,"limit":1}),
        );
        let first_token = first[0]["fencingToken"].as_i64().unwrap();
        let mut competitor = Actor::open(&path).unwrap();
        assert_eq!(
            result(
                &mut competitor,
                "work.claim",
                json!({"graphId":"durable","ownerId":"competitor","now":10,"leaseMs":10,"limit":1}),
            ),
            json!([]),
        );
        drop(competitor);
        drop(actor);

        let mut actor = Actor::open(&path).unwrap();
        assert_eq!(
            result(
                &mut actor,
                "work.claim",
                json!({"graphId":"durable","ownerId":"two","now":19,"leaseMs":10,"limit":1}),
            ),
            json!([]),
        );
        let second = result(
            &mut actor,
            "work.claim",
            json!({"graphId":"durable","ownerId":"two","now":20,"leaseMs":10,"limit":1}),
        );
        let second_token = second[0]["fencingToken"].as_i64().unwrap();
        assert_eq!(second_token, first_token + 1);
        for method in ["work.heartbeat", "work.complete"] {
            let params = if method == "work.heartbeat" {
                json!({
                    "graphId":"durable","itemId":"only","ownerId":"one",
                    "fencingToken":first_token,"now":21,"leaseMs":10
                })
            } else {
                json!({
                    "graphId":"durable","itemId":"only","ownerId":"one",
                    "fencingToken":first_token,"completedAt":21,"outcome":{}
                })
            };
            match actor.handle(request(2, method, params)) {
                Response::Err { error, .. } => assert_eq!(error.code, "CONFLICT"),
                _ => panic!("stale work owner succeeded"),
            }
        }
        let heartbeat = result(
            &mut actor,
            "work.heartbeat",
            json!({
                "graphId":"durable","itemId":"only","ownerId":"two",
                "fencingToken":second_token,"now":21,"leaseMs":10
            }),
        );
        assert_eq!(heartbeat["leaseExpiresAt"], json!(31));
    }

    #[test]
    fn version_five_database_migrates_the_work_ledger_transactionally() {
        let root = tempdir().unwrap();
        let path = root.path().join("actor.sqlite3");
        let actor = Actor::open(&path).unwrap();
        actor
            .connection
            .execute_batch(
                "DROP TABLE work_dependencies;
                 DROP TABLE work_items;
                 DROP TABLE work_graphs;
                 PRAGMA user_version = 5;",
            )
            .unwrap();
        drop(actor);

        let mut migrated = Actor::open(&path).unwrap();
        let version: i64 = migrated
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        result(
            &mut migrated,
            "work.putGraph",
            json!({"graphId":"migrated","items":[{"itemId":"ready","dependsOn":[]}]}),
        );
        let claim = result(
            &mut migrated,
            "work.claim",
            json!({"graphId":"migrated","ownerId":"owner","now":1,"leaseMs":1,"limit":1}),
        );
        assert_eq!(claim[0]["itemId"], json!("ready"));
    }

    #[test]
    fn protocol_rejects_schema_and_noncanonical_revision_mismatches() {
        assert_eq!(
            parse_request(r#"{"schemaVersion":2,"id":"x","method":"health","params":{}}"#)
                .unwrap_err()
                .code,
            "INVALID_REQUEST",
        );
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        match actor.handle(request(
            1,
            "session.append",
            json!({
                "sessionId":"s","expectedRevision":"01","events":[]
            }),
        )) {
            Response::Err { error, .. } => assert_eq!(error.code, "INVALID_REQUEST"),
            _ => panic!("noncanonical revision succeeded"),
        }
        let encoded = serde_json::to_value(actor.handle(request(2, "health", json!({})))).unwrap();
        assert_eq!(encoded["schemaVersion"], json!(1));
        assert_eq!(encoded["ok"], json!(true));
    }
}
