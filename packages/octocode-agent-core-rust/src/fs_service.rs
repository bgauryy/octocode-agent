use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

pub const PROTOCOL_VERSION: i64 = 1;
pub const MAX_CONTENT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

const CHECKPOINT_DIRECTORY: &str = ".octocode-agent-checkpoints-v1";
const MAX_CHECKPOINT_RECORD_BYTES: usize = 32 * 1024;
const MAX_CHECKPOINT_STORAGE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CHECKPOINT_STORAGE_FILES: usize = 256;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct FsError {
    pub code: &'static str,
    pub message: String,
    pub committed: bool,
}

pub type FsResult<T> = Result<T, FsError>;

impl FsError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message: message.into(),
            committed: false,
        }
    }

    fn invalid(message: &'static str) -> Self {
        Self::new("INVALID_REQUEST", message)
    }

    fn invalid_path() -> Self {
        Self::new(
            "INVALID_PATH",
            "Path must be a non-empty relative file path",
        )
    }

    fn io(error: &std::io::Error) -> Self {
        match error.raw_os_error() {
            Some(libc::ENOENT) => Self::new("NOT_FOUND", "File does not exist"),
            Some(libc::EACCES | libc::EPERM) => {
                Self::new("PERMISSION_DENIED", "File operation was not permitted")
            }
            Some(libc::ELOOP) => Self::new(
                "SYMLINK_FORBIDDEN",
                "File path cannot traverse a symbolic link",
            ),
            _ => Self::new("IO_FAILURE", "File operation failed"),
        }
    }

    fn after_commit(mut self) -> Self {
        self.committed = true;
        self
    }
}

#[derive(Debug)]
struct RelativePath {
    display: String,
    components: Vec<OsString>,
}

impl RelativePath {
    fn parse(value: &str) -> FsResult<Self> {
        if value.is_empty() || value.len() > 4096 {
            return Err(FsError::invalid_path());
        }
        let mut components = Vec::new();
        for component in Path::new(value).components() {
            match component {
                Component::Normal(value) => components.push(value.to_os_string()),
                _ => return Err(FsError::invalid_path()),
            }
        }
        if components.is_empty() {
            return Err(FsError::invalid_path());
        }
        if components.first().map(OsString::as_os_str) == Some(OsStr::new(CHECKPOINT_DIRECTORY)) {
            return Err(FsError::invalid_path());
        }
        let display = components
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        Ok(Self {
            display,
            components,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathParams {
    path: String,
    #[serde(rename = "maxBytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplaceParams {
    path: String,
    #[serde(rename = "contentBase64")]
    content_base64: String,
    #[serde(rename = "expectedSha256")]
    expected_sha256: ExpectedSha,
    #[serde(rename = "maxBytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ExpectedSha {
    Digest(String),
    Create(()),
}

impl ExpectedSha {
    fn as_deref(&self) -> Option<&str> {
        match self {
            Self::Digest(value) => Some(value),
            Self::Create(()) => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteParams {
    path: String,
    #[serde(rename = "expectedSha256")]
    expected_sha256: String,
    #[serde(rename = "maxBytes")]
    max_bytes: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum MutationOperation {
    Write,
    Edit,
}

struct PrepareReplaceRequest<'a> {
    checkpoint_id: String,
    operation: MutationOperation,
    relative: &'a RelativePath,
    bytes: &'a [u8],
    expected: Option<&'a str>,
    maximum: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareReplaceParams {
    #[serde(rename = "checkpointId")]
    checkpoint_id: String,
    operation: MutationOperation,
    path: String,
    #[serde(rename = "contentBase64")]
    content_base64: String,
    #[serde(rename = "expectedSha256")]
    expected_sha256: ExpectedSha,
    #[serde(rename = "maxBytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareDeleteParams {
    #[serde(rename = "checkpointId")]
    checkpoint_id: String,
    path: String,
    #[serde(rename = "expectedSha256")]
    expected_sha256: String,
    #[serde(rename = "maxBytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareRewindParams {
    #[serde(rename = "checkpointId")]
    checkpoint_id: String,
    #[serde(rename = "rewindId")]
    rewind_id: String,
    path: String,
    #[serde(rename = "expectedPostimageSha256")]
    expected_postimage_sha256: ExpectedSha,
    #[serde(rename = "maxBytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttemptParams {
    #[serde(rename = "attemptId")]
    attempt_id: String,
    #[serde(rename = "maxBytes")]
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorizeExternalPathParams {
    path: String,
    kind: ExternalPathKind,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ExternalPathKind {
    Input,
    Output,
}

#[derive(Debug)]
struct Snapshot {
    bytes: Vec<u8>,
    sha256: String,
    mode: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AttemptKind {
    Mutation,
    Rewind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum JournalOperation {
    Write,
    Edit,
    Delete,
    Rewind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum JournalImageKind {
    Absent,
    Present,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalImage {
    kind: JournalImageKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blob_sha256: Option<String>,
}

impl JournalImage {
    fn absent() -> Self {
        Self {
            kind: JournalImageKind::Absent,
            sha256: None,
            bytes: None,
            mode: None,
            blob_sha256: None,
        }
    }

    fn present(snapshot: &Snapshot) -> Self {
        Self {
            kind: JournalImageKind::Present,
            sha256: Some(snapshot.sha256.clone()),
            bytes: Some(snapshot.bytes.len()),
            mode: Some(snapshot.mode),
            blob_sha256: Some(snapshot.sha256.clone()),
        }
    }

    fn validate(&self) -> FsResult<()> {
        match self.kind {
            JournalImageKind::Absent => {
                if self.sha256.is_some()
                    || self.bytes.is_some()
                    || self.mode.is_some()
                    || self.blob_sha256.is_some()
                {
                    return Err(FsError::new(
                        "CHECKPOINT_CORRUPT",
                        "Checkpoint image is invalid",
                    ));
                }
            }
            JournalImageKind::Present => {
                let sha256 = self.sha256.as_deref().ok_or_else(|| {
                    FsError::new("CHECKPOINT_CORRUPT", "Checkpoint image is invalid")
                })?;
                validate_sha(sha256).map_err(|_| {
                    FsError::new("CHECKPOINT_CORRUPT", "Checkpoint image is invalid")
                })?;
                if self.blob_sha256.as_deref() != Some(sha256)
                    || self.bytes.is_none_or(|bytes| bytes > MAX_CONTENT_BYTES)
                    || self.mode.is_none_or(|mode| mode > 0o7777)
                {
                    return Err(FsError::new(
                        "CHECKPOINT_CORRUPT",
                        "Checkpoint image is invalid",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalRecord {
    schema_version: i64,
    attempt_id: String,
    checkpoint_id: String,
    attempt_kind: AttemptKind,
    operation: JournalOperation,
    path: String,
    before: JournalImage,
    after: JournalImage,
}

impl JournalRecord {
    fn validate(&self) -> FsResult<()> {
        validate_attempt_id(&self.attempt_id)?;
        validate_attempt_id(&self.checkpoint_id)?;
        RelativePath::parse(&self.path)
            .map_err(|_| FsError::new("CHECKPOINT_CORRUPT", "Checkpoint path is invalid"))?;
        if self.schema_version != PROTOCOL_VERSION
            || (self.attempt_kind == AttemptKind::Mutation
                && (self.attempt_id != self.checkpoint_id
                    || self.operation == JournalOperation::Rewind))
            || (self.attempt_kind == AttemptKind::Rewind
                && self.operation != JournalOperation::Rewind)
            || (self.operation == JournalOperation::Delete
                && self.after.kind != JournalImageKind::Absent)
        {
            return Err(FsError::new(
                "CHECKPOINT_CORRUPT",
                "Checkpoint record is invalid",
            ));
        }
        self.before.validate()?;
        self.after.validate()?;
        Ok(())
    }
}

#[derive(Debug)]
pub struct WorkspaceFs {
    root: File,
    root_path: PathBuf,
    max_bytes: usize,
    mutation_lock: Mutex<()>,
}

impl WorkspaceFs {
    pub fn open(path: impl AsRef<Path>, max_bytes: usize) -> FsResult<Self> {
        if max_bytes == 0 || max_bytes > MAX_CONTENT_BYTES {
            return Err(FsError::invalid("maxBytes must be between 1 and 10485760"));
        }
        let root_path = std::fs::canonicalize(path).map_err(|error| FsError::io(&error))?;
        let root = File::open(&root_path).map_err(|error| FsError::io(&error))?;
        if !root
            .metadata()
            .map_err(|error| FsError::io(&error))?
            .is_dir()
        {
            return Err(FsError::new(
                "INVALID_WORKSPACE",
                "Workspace must be a directory",
            ));
        }
        Ok(Self {
            root,
            root_path,
            max_bytes,
            mutation_lock: Mutex::new(()),
        })
    }

    #[cfg(test)]
    pub fn dispatch(&self, method: &str, params: &Value) -> FsResult<Value> {
        self.dispatch_with_cancel(method, params, &AtomicBool::new(false))
    }

    pub fn dispatch_with_cancel(
        &self,
        method: &str,
        params: &Value,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        if !params.is_object() {
            return Err(FsError::invalid("params must be an object"));
        }
        match method {
            "health" => {
                parse_params::<EmptyParams>(params)?;
                Ok(json!({
                    "status":"ok",
                    "schemaVersion":PROTOCOL_VERSION,
                    "maxBytes":self.max_bytes,
                    "cancellation":"cooperative-before-commit",
                    "checkpointJournal":"content-addressed-v1"
                }))
            }
            "fs.read" => {
                let input = parse_params::<PathParams>(params)?;
                let maximum = self.request_maximum(input.max_bytes)?;
                self.read(&RelativePath::parse(&input.path)?, true, maximum, cancelled)
            }
            "fs.hash" => {
                let input = parse_params::<PathParams>(params)?;
                let maximum = self.request_maximum(input.max_bytes)?;
                self.read(
                    &RelativePath::parse(&input.path)?,
                    false,
                    maximum,
                    cancelled,
                )
            }
            "fs.authorizeExternalPath" => {
                let input = parse_params::<AuthorizeExternalPathParams>(params)?;
                let relative = RelativePath::parse(&input.path)?;
                self.authorize_external_path(&relative, input.kind, cancelled)
            }
            "fs.replace" => {
                let input = parse_params::<ReplaceParams>(params)?;
                validate_optional_sha(input.expected_sha256.as_deref())?;
                let maximum = self.request_maximum(input.max_bytes)?;
                let bytes = decode_content(&input.content_base64, maximum)?;
                let relative = RelativePath::parse(&input.path)?;
                let _guard = self
                    .mutation_lock
                    .lock()
                    .map_err(|_| FsError::new("IO_FAILURE", "File operation failed"))?;
                self.replace(
                    &relative,
                    &bytes,
                    input.expected_sha256.as_deref(),
                    maximum,
                    cancelled,
                    None,
                )
            }
            "fs.delete" => {
                let input = parse_params::<DeleteParams>(params)?;
                validate_sha(&input.expected_sha256)?;
                let maximum = self.request_maximum(input.max_bytes)?;
                let relative = RelativePath::parse(&input.path)?;
                let _guard = self
                    .mutation_lock
                    .lock()
                    .map_err(|_| FsError::new("IO_FAILURE", "File operation failed"))?;
                self.delete(&relative, &input.expected_sha256, maximum, cancelled)
            }
            "fs.checkpoint.prepareReplace" => {
                let input = parse_params::<PrepareReplaceParams>(params)?;
                validate_attempt_id(&input.checkpoint_id)?;
                validate_optional_sha(input.expected_sha256.as_deref())?;
                let maximum = self.request_maximum(input.max_bytes)?;
                let bytes = decode_content(&input.content_base64, maximum)?;
                let relative = RelativePath::parse(&input.path)?;
                let _guard = self
                    .mutation_lock
                    .lock()
                    .map_err(|_| FsError::new("IO_FAILURE", "File operation failed"))?;
                self.prepare_replace(
                    PrepareReplaceRequest {
                        checkpoint_id: input.checkpoint_id,
                        operation: input.operation,
                        relative: &relative,
                        bytes: &bytes,
                        expected: input.expected_sha256.as_deref(),
                        maximum,
                    },
                    cancelled,
                )
            }
            "fs.checkpoint.prepareDelete" => {
                let input = parse_params::<PrepareDeleteParams>(params)?;
                validate_attempt_id(&input.checkpoint_id)?;
                validate_sha(&input.expected_sha256)?;
                let maximum = self.request_maximum(input.max_bytes)?;
                let relative = RelativePath::parse(&input.path)?;
                let _guard = self
                    .mutation_lock
                    .lock()
                    .map_err(|_| FsError::new("IO_FAILURE", "File operation failed"))?;
                self.prepare_delete(
                    input.checkpoint_id,
                    &relative,
                    &input.expected_sha256,
                    maximum,
                    cancelled,
                )
            }
            "fs.checkpoint.prepareRewind" => {
                let input = parse_params::<PrepareRewindParams>(params)?;
                validate_attempt_id(&input.checkpoint_id)?;
                validate_attempt_id(&input.rewind_id)?;
                validate_optional_sha(input.expected_postimage_sha256.as_deref())?;
                let maximum = self.request_maximum(input.max_bytes)?;
                let relative = RelativePath::parse(&input.path)?;
                let _guard = self
                    .mutation_lock
                    .lock()
                    .map_err(|_| FsError::new("IO_FAILURE", "File operation failed"))?;
                self.prepare_rewind(
                    input.checkpoint_id,
                    input.rewind_id,
                    &relative,
                    input.expected_postimage_sha256.as_deref(),
                    maximum,
                    cancelled,
                )
            }
            "fs.checkpoint.apply" => {
                let input = parse_params::<AttemptParams>(params)?;
                validate_attempt_id(&input.attempt_id)?;
                let maximum = self.request_maximum(input.max_bytes)?;
                let _guard = self
                    .mutation_lock
                    .lock()
                    .map_err(|_| FsError::new("IO_FAILURE", "File operation failed"))?;
                self.apply_attempt(&input.attempt_id, maximum, cancelled)
            }
            "fs.checkpoint.recover" => {
                let input = parse_params::<AttemptParams>(params)?;
                validate_attempt_id(&input.attempt_id)?;
                let maximum = self.request_maximum(input.max_bytes)?;
                let _guard = self
                    .mutation_lock
                    .lock()
                    .map_err(|_| FsError::new("IO_FAILURE", "File operation failed"))?;
                self.recover_attempt(&input.attempt_id, maximum, cancelled)
            }
            _ => Err(FsError::new("METHOD_NOT_FOUND", "Unknown method")),
        }
    }

    fn read(
        &self,
        relative: &RelativePath,
        include_content: bool,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        let (parent, name) = self.open_parent(relative)?;
        let snapshot = self.snapshot(&parent, &name, maximum, cancelled)?;
        let mut result = json!({
            "path":relative.display,
            "bytes":snapshot.bytes.len(),
            "sha256":snapshot.sha256,
            "validUtf8":std::str::from_utf8(&snapshot.bytes).is_ok()
        });
        if include_content {
            result["contentBase64"] = Value::String(BASE64.encode(snapshot.bytes));
        }
        Ok(result)
    }

    fn authorize_external_path(
        &self,
        relative: &RelativePath,
        kind: ExternalPathKind,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        let (parent, name) = self.open_parent(relative)?;
        match kind {
            ExternalPathKind::Input => {
                let file = open_regular(&parent, &name)?;
                if !file
                    .metadata()
                    .map_err(|error| FsError::io(&error))?
                    .is_file()
                {
                    return Err(FsError::new(
                        "NOT_REGULAR_FILE",
                        "File path must identify a regular file",
                    ));
                }
            }
            ExternalPathKind::Output => match open_regular(&parent, &name) {
                Ok(file) => {
                    if !file
                        .metadata()
                        .map_err(|error| FsError::io(&error))?
                        .is_file()
                    {
                        return Err(FsError::new(
                            "NOT_REGULAR_FILE",
                            "File path must identify a regular file",
                        ));
                    }
                }
                Err(error) if error.code == "NOT_FOUND" => {}
                Err(error) => return Err(error),
            },
        }
        check_cancelled(cancelled)?;
        let kind_name = match kind {
            ExternalPathKind::Input => "input",
            ExternalPathKind::Output => "output",
        };
        let host_path = relative
            .components
            .iter()
            .fold(self.root_path.clone(), |path, component| {
                path.join(component)
            });
        Ok(json!({
            "path": relative.display,
            "hostPath": host_path.to_string_lossy(),
            "kind": kind_name,
        }))
    }

    fn replace(
        &self,
        relative: &RelativePath,
        bytes: &[u8],
        expected: Option<&str>,
        maximum: usize,
        cancelled: &AtomicBool,
        mode_override: Option<u32>,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        let (parent, name) = self.open_parent(relative)?;
        let current = match self.snapshot(&parent, &name, maximum, cancelled) {
            Ok(value) => Some(value),
            Err(error) if error.code == "NOT_FOUND" => None,
            Err(error) => return Err(error),
        };
        assert_precondition(current.as_ref(), expected)?;
        let (temporary_name, mut temporary) = create_temporary(&parent)?;
        let mut temporary_present = true;
        let operation = (|| -> FsResult<bool> {
            if let Some(mode) =
                mode_override.or_else(|| current.as_ref().map(|snapshot| snapshot.mode))
            {
                chmod(temporary.as_raw_fd(), mode)?;
            }
            for chunk in bytes.chunks(64 * 1024) {
                check_cancelled(cancelled)?;
                temporary
                    .write_all(chunk)
                    .map_err(|error| FsError::io(&error))?;
            }
            temporary.sync_all().map_err(|error| FsError::io(&error))?;
            check_cancelled(cancelled)?;
            let latest = match self.snapshot(&parent, &name, maximum, cancelled) {
                Ok(value) => Some(value),
                Err(error) if error.code == "NOT_FOUND" => None,
                Err(error) => return Err(error),
            };
            assert_same_snapshot(current.as_ref(), latest.as_ref())?;
            check_cancelled(cancelled)?;
            if expected.is_none() {
                link_at(&parent, &temporary_name, &name)?;
                unlink_at(&parent, &temporary_name, false).map_err(FsError::after_commit)?;
                temporary_present = false;
            } else {
                rename_at(&parent, &temporary_name, &name)?;
                temporary_present = false;
            }
            sync_parent(&parent).map_err(FsError::after_commit)
        })();
        if temporary_present {
            let _ = unlink_at(&parent, &temporary_name, false);
        }
        let parent_durable = operation?;
        let sha256 = digest(bytes);
        Ok(json!({
            "path":relative.display,
            "bytes":bytes.len(),
            "sha256":sha256,
            "previousSha256":current.map(|value| value.sha256),
            "committed":true,
            "durability":if parent_durable { "file-and-parent" } else { "file-only" }
        }))
    }

    fn delete(
        &self,
        relative: &RelativePath,
        expected: &str,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        let (parent, name) = self.open_parent(relative)?;
        let current = self.snapshot(&parent, &name, maximum, cancelled)?;
        assert_precondition(Some(&current), Some(expected))?;
        let latest = self.snapshot(&parent, &name, maximum, cancelled)?;
        assert_same_snapshot(Some(&current), Some(&latest))?;
        check_cancelled(cancelled)?;
        unlink_at(&parent, &name, false)?;
        let parent_durable = sync_parent(&parent).map_err(FsError::after_commit)?;
        Ok(json!({
            "path":relative.display,
            "previousSha256":current.sha256,
            "committed":true,
            "durability":if parent_durable { "parent" } else { "best-effort-parent" }
        }))
    }

    fn prepare_replace(
        &self,
        request: PrepareReplaceRequest<'_>,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        let PrepareReplaceRequest {
            checkpoint_id,
            operation,
            relative,
            bytes,
            expected,
            maximum,
        } = request;
        check_cancelled(cancelled)?;
        if operation == MutationOperation::Edit && expected.is_none() {
            return Err(FsError::invalid(
                "edit checkpoints require an existing-file SHA-256 precondition",
            ));
        }
        let current = self.snapshot_optional(relative, maximum, cancelled)?;
        assert_precondition(current.as_ref(), expected)?;
        let next = Snapshot {
            bytes: bytes.to_vec(),
            sha256: digest(bytes),
            mode: current.as_ref().map_or(0o600, |snapshot| snapshot.mode),
        };
        let record = JournalRecord {
            schema_version: PROTOCOL_VERSION,
            attempt_id: checkpoint_id.clone(),
            checkpoint_id,
            attempt_kind: AttemptKind::Mutation,
            operation: match operation {
                MutationOperation::Write => JournalOperation::Write,
                MutationOperation::Edit => JournalOperation::Edit,
            },
            path: relative.display.clone(),
            before: current
                .as_ref()
                .map_or_else(JournalImage::absent, JournalImage::present),
            after: JournalImage::present(&next),
        };
        let mut blobs = Vec::new();
        if let Some(snapshot) = &current {
            blobs.push((snapshot.sha256.as_str(), snapshot.bytes.as_slice()));
        }
        blobs.push((next.sha256.as_str(), next.bytes.as_slice()));
        self.persist_record(&record, &blobs, cancelled)
    }

    fn prepare_delete(
        &self,
        checkpoint_id: String,
        relative: &RelativePath,
        expected: &str,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        let current = self.snapshot_optional(relative, maximum, cancelled)?;
        assert_precondition(current.as_ref(), Some(expected))?;
        let current = current.expect("precondition proves presence");
        let record = JournalRecord {
            schema_version: PROTOCOL_VERSION,
            attempt_id: checkpoint_id.clone(),
            checkpoint_id,
            attempt_kind: AttemptKind::Mutation,
            operation: JournalOperation::Delete,
            path: relative.display.clone(),
            before: JournalImage::present(&current),
            after: JournalImage::absent(),
        };
        self.persist_record(
            &record,
            &[(current.sha256.as_str(), current.bytes.as_slice())],
            cancelled,
        )
    }

    fn prepare_rewind(
        &self,
        checkpoint_id: String,
        rewind_id: String,
        relative: &RelativePath,
        expected_postimage: Option<&str>,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        let (_, checkpoint, _) = self.load_record(&checkpoint_id, cancelled)?;
        if checkpoint.attempt_kind != AttemptKind::Mutation
            || checkpoint.path != relative.display
            || image_digest(&checkpoint.after) != expected_postimage
        {
            return Err(FsError::new(
                "PRECONDITION_FAILED",
                "Checkpoint rewind precondition failed",
            ));
        }
        match self.observe(relative, maximum, cancelled)? {
            ObservedImage::Known(current) if image_matches(&current, &checkpoint.after) => {}
            _ => {
                return Err(FsError::new(
                    "PRECONDITION_FAILED",
                    "Checkpoint postimage no longer matches the target",
                ))
            }
        }
        let record = JournalRecord {
            schema_version: PROTOCOL_VERSION,
            attempt_id: rewind_id,
            checkpoint_id,
            attempt_kind: AttemptKind::Rewind,
            operation: JournalOperation::Rewind,
            path: relative.display.clone(),
            before: checkpoint.after,
            after: checkpoint.before,
        };
        self.persist_record(&record, &[], cancelled)
    }

    fn apply_attempt(
        &self,
        attempt_id: &str,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        let (directory, record, _) = self.load_record(attempt_id, cancelled)?;
        let relative = RelativePath::parse(&record.path)
            .map_err(|_| FsError::new("CHECKPOINT_CORRUPT", "Checkpoint path is invalid"))?;
        let current = match self.observe(&relative, maximum, cancelled)? {
            ObservedImage::Known(image) => image,
            ObservedImage::Unknown(_) => {
                return Err(FsError::new(
                    "PRECONDITION_FAILED",
                    "Checkpoint target cannot be observed safely",
                ))
            }
        };
        if image_matches(&current, &record.after) {
            return Err(FsError::new(
                "ALREADY_APPLIED",
                "Checkpoint transition is already applied",
            ));
        }
        if !image_matches(&current, &record.before) {
            return Err(FsError::new(
                "PRECONDITION_FAILED",
                "Checkpoint target diverged before apply",
            ));
        }
        self.validate_image_blob(&directory, &record.after, cancelled)?;
        check_cancelled(cancelled)?;
        match record.after.kind {
            JournalImageKind::Absent => {
                if current.kind == JournalImageKind::Present {
                    self.delete(
                        &relative,
                        current.sha256.as_deref().expect("present image has digest"),
                        maximum,
                        cancelled,
                    )?;
                }
            }
            JournalImageKind::Present => {
                let bytes = self.read_image_blob(&directory, &record.after, cancelled)?;
                if bytes.len() > maximum {
                    return Err(FsError::new(
                        "TOO_LARGE",
                        "Checkpoint image exceeds requested byte limit",
                    ));
                }
                self.replace(
                    &relative,
                    &bytes,
                    current.sha256.as_deref(),
                    maximum,
                    cancelled,
                    record.after.mode,
                )?;
            }
        }
        self.recover_attempt(attempt_id, maximum, cancelled)
    }

    fn recover_attempt(
        &self,
        attempt_id: &str,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        let (_, record, journal_sha256) = self.load_record(attempt_id, cancelled)?;
        let relative = RelativePath::parse(&record.path)
            .map_err(|_| FsError::new("CHECKPOINT_CORRUPT", "Checkpoint path is invalid"))?;
        let observed = self.observe(&relative, maximum, cancelled)?;
        Ok(recovery_value(&record, &journal_sha256, observed))
    }

    fn snapshot_optional(
        &self,
        relative: &RelativePath,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Option<Snapshot>> {
        let (parent, name) = self.open_parent(relative)?;
        match self.snapshot(&parent, &name, maximum, cancelled) {
            Ok(snapshot) => Ok(Some(snapshot)),
            Err(error) if error.code == "NOT_FOUND" => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn observe(
        &self,
        relative: &RelativePath,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<ObservedImage> {
        check_cancelled(cancelled)?;
        let (parent, name) = match self.open_parent(relative) {
            Ok(value) => value,
            Err(error) if error.code == "NOT_FOUND" => {
                return Ok(ObservedImage::Known(JournalImage::absent()))
            }
            Err(error)
                if matches!(
                    error.code,
                    "SYMLINK_FORBIDDEN" | "NOT_REGULAR_FILE" | "PERMISSION_DENIED"
                ) =>
            {
                return Ok(ObservedImage::Unknown(
                    "current file cannot be observed safely".into(),
                ))
            }
            Err(error) => return Err(error),
        };
        match self.snapshot(&parent, &name, maximum, cancelled) {
            Ok(snapshot) => Ok(ObservedImage::Known(JournalImage::present(&snapshot))),
            Err(error) if error.code == "NOT_FOUND" => {
                Ok(ObservedImage::Known(JournalImage::absent()))
            }
            Err(error) if error.code == "TOO_LARGE" => Ok(ObservedImage::Unknown(
                "current file exceeds the bounded observation limit".into(),
            )),
            Err(error)
                if matches!(
                    error.code,
                    "SYMLINK_FORBIDDEN" | "NOT_REGULAR_FILE" | "PERMISSION_DENIED"
                ) =>
            {
                Ok(ObservedImage::Unknown(
                    "current file cannot be observed safely".into(),
                ))
            }
            Err(error) => Err(error),
        }
    }

    fn persist_record(
        &self,
        record: &JournalRecord,
        blobs: &[(&str, &[u8])],
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        record.validate()?;
        check_cancelled(cancelled)?;
        let directory = self.checkpoint_directory()?;
        let record_name = record_file_name(&record.attempt_id);
        if read_internal_optional(
            &directory,
            OsStr::new(&record_name),
            MAX_CHECKPOINT_RECORD_BYTES,
            cancelled,
        )?
        .is_some()
        {
            return Err(FsError::new(
                "CHECKPOINT_EXISTS",
                "Checkpoint attempt already exists",
            ));
        }
        let record_bytes = serde_json::to_vec(record)
            .map_err(|_| FsError::new("IO_FAILURE", "Checkpoint record could not be encoded"))?;
        if record_bytes.len() > MAX_CHECKPOINT_RECORD_BYTES {
            return Err(FsError::new(
                "TOO_LARGE",
                "Checkpoint record exceeds its byte limit",
            ));
        }

        let mut missing: Vec<(&str, &[u8])> = Vec::new();
        for (sha256, bytes) in blobs {
            if digest(bytes) != *sha256 {
                return Err(FsError::new(
                    "CHECKPOINT_CORRUPT",
                    "Checkpoint blob digest is invalid",
                ));
            }
            if missing.iter().any(|(candidate, _)| candidate == sha256) {
                continue;
            }
            let name = blob_file_name(sha256);
            match read_internal_optional(
                &directory,
                OsStr::new(&name),
                MAX_CONTENT_BYTES,
                cancelled,
            )? {
                Some(existing) if existing.len() == bytes.len() && digest(&existing) == *sha256 => {
                }
                Some(_) => {
                    return Err(FsError::new(
                        "CHECKPOINT_CORRUPT",
                        "Checkpoint blob failed integrity validation",
                    ))
                }
                None => missing.push((sha256, bytes)),
            }
        }
        let additional_bytes =
            missing
                .iter()
                .try_fold(record_bytes.len() as u64, |sum, (_, bytes)| {
                    sum.checked_add(bytes.len() as u64).ok_or_else(|| {
                        FsError::new(
                            "CHECKPOINT_STORAGE_FULL",
                            "Checkpoint storage limit reached",
                        )
                    })
                })?;
        ensure_checkpoint_capacity(&directory, missing.len() + 1, additional_bytes)?;
        for (sha256, bytes) in missing {
            check_cancelled(cancelled)?;
            write_internal_once(&directory, OsStr::new(&blob_file_name(sha256)), bytes)?;
        }
        check_cancelled(cancelled)?;
        write_internal_once(&directory, OsStr::new(&record_name), &record_bytes)?;
        let journal_sha256 = digest(&record_bytes);
        Ok(transition_value(record, &journal_sha256))
    }

    fn load_record(
        &self,
        attempt_id: &str,
        cancelled: &AtomicBool,
    ) -> FsResult<(File, JournalRecord, String)> {
        validate_attempt_id(attempt_id)?;
        let directory = self.checkpoint_directory()?;
        let record_name = record_file_name(attempt_id);
        let bytes = read_internal_optional(
            &directory,
            OsStr::new(&record_name),
            MAX_CHECKPOINT_RECORD_BYTES,
            cancelled,
        )?
        .ok_or_else(|| FsError::new("CHECKPOINT_NOT_FOUND", "Checkpoint attempt does not exist"))?;
        let record: JournalRecord = serde_json::from_slice(&bytes)
            .map_err(|_| FsError::new("CHECKPOINT_CORRUPT", "Checkpoint record is malformed"))?;
        record.validate()?;
        if record.attempt_id != attempt_id {
            return Err(FsError::new(
                "CHECKPOINT_CORRUPT",
                "Checkpoint record identity is invalid",
            ));
        }
        self.validate_image_blob(&directory, &record.before, cancelled)?;
        self.validate_image_blob(&directory, &record.after, cancelled)?;
        Ok((directory, record, digest(&bytes)))
    }

    fn validate_image_blob(
        &self,
        directory: &File,
        image: &JournalImage,
        cancelled: &AtomicBool,
    ) -> FsResult<()> {
        if image.kind == JournalImageKind::Present {
            self.read_image_blob(directory, image, cancelled)?;
        }
        Ok(())
    }

    fn read_image_blob(
        &self,
        directory: &File,
        image: &JournalImage,
        cancelled: &AtomicBool,
    ) -> FsResult<Vec<u8>> {
        image.validate()?;
        let sha256 = image
            .sha256
            .as_deref()
            .ok_or_else(|| FsError::new("CHECKPOINT_CORRUPT", "Checkpoint image has no blob"))?;
        let bytes = read_internal_optional(
            directory,
            OsStr::new(&blob_file_name(sha256)),
            MAX_CONTENT_BYTES,
            cancelled,
        )?
        .ok_or_else(|| FsError::new("CHECKPOINT_CORRUPT", "Checkpoint blob is missing"))?;
        if image.bytes != Some(bytes.len()) || digest(&bytes) != sha256 {
            return Err(FsError::new(
                "CHECKPOINT_CORRUPT",
                "Checkpoint blob failed integrity validation",
            ));
        }
        Ok(bytes)
    }

    fn checkpoint_directory(&self) -> FsResult<File> {
        let name = OsStr::new(CHECKPOINT_DIRECTORY);
        match mkdir_at(&self.root, name, 0o700) {
            Ok(()) => {
                sync_parent(&self.root)?;
            }
            Err(error) if error.code == "ALREADY_EXISTS" => {}
            Err(error) => return Err(error),
        }
        let directory = open_directory(&self.root, name)?;
        let metadata = directory.metadata().map_err(|error| FsError::io(&error))?;
        if metadata.mode() & 0o077 != 0 {
            return Err(FsError::new(
                "CHECKPOINT_CORRUPT",
                "Checkpoint directory permissions are unsafe",
            ));
        }
        Ok(directory)
    }

    fn open_parent(&self, relative: &RelativePath) -> FsResult<(File, OsString)> {
        let mut parent = self.root.try_clone().map_err(|error| FsError::io(&error))?;
        for component in &relative.components[..relative.components.len() - 1] {
            parent = open_directory(&parent, component)?;
        }
        Ok((parent, relative.components.last().unwrap().clone()))
    }

    fn snapshot(
        &self,
        parent: &File,
        name: &OsStr,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Snapshot> {
        let mut file = open_regular(parent, name)?;
        let metadata = file.metadata().map_err(|error| FsError::io(&error))?;
        if !metadata.file_type().is_file() {
            return Err(FsError::new(
                "NOT_REGULAR_FILE",
                "File path must identify a regular file",
            ));
        }
        if metadata.len() > maximum as u64 {
            return Err(FsError::new(
                "TOO_LARGE",
                "File exceeds configured byte limit",
            ));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        let mut buffer = [0u8; 64 * 1024];
        loop {
            check_cancelled(cancelled)?;
            let count = file
                .read(&mut buffer)
                .map_err(|error| FsError::io(&error))?;
            if count == 0 {
                break;
            }
            if bytes.len() + count > maximum {
                return Err(FsError::new(
                    "TOO_LARGE",
                    "File exceeds configured byte limit",
                ));
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        Ok(Snapshot {
            sha256: digest(&bytes),
            bytes,
            mode: metadata.mode() & 0o7777,
        })
    }

    fn request_maximum(&self, maximum: usize) -> FsResult<usize> {
        if maximum == 0 || maximum > self.max_bytes {
            Err(FsError::invalid(
                "maxBytes must be between 1 and the service byte limit",
            ))
        } else {
            Ok(maximum)
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

enum ObservedImage {
    Known(JournalImage),
    Unknown(String),
}

fn validate_attempt_id(value: &str) -> FsResult<()> {
    if !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(FsError::invalid(
            "checkpoint and rewind identifiers must contain 1 to 256 non-control characters",
        ))
    }
}

fn decode_content(value: &str, maximum: usize) -> FsResult<Vec<u8>> {
    let maximum_encoded = maximum.div_ceil(3) * 4;
    if value.len() > maximum_encoded {
        return Err(FsError::new(
            "TOO_LARGE",
            "File exceeds configured byte limit",
        ));
    }
    let bytes = BASE64
        .decode(value)
        .map_err(|_| FsError::invalid("contentBase64 must be canonical base64"))?;
    if BASE64.encode(&bytes) != value {
        return Err(FsError::invalid("contentBase64 must be canonical base64"));
    }
    if bytes.len() > maximum {
        return Err(FsError::new(
            "TOO_LARGE",
            "File exceeds configured byte limit",
        ));
    }
    Ok(bytes)
}

fn image_digest(image: &JournalImage) -> Option<&str> {
    image.sha256.as_deref()
}

fn image_matches(left: &JournalImage, right: &JournalImage) -> bool {
    left.kind == right.kind
        && left.sha256 == right.sha256
        && left.bytes == right.bytes
        && left.mode == right.mode
}

fn public_image(image: &JournalImage) -> Value {
    match image.kind {
        JournalImageKind::Absent => json!({"kind":"absent"}),
        JournalImageKind::Present => json!({
            "kind":"present",
            "sha256":image.sha256.as_deref(),
            "bytes":image.bytes,
            "mode":image.mode,
        }),
    }
}

fn attempt_kind_name(kind: AttemptKind) -> &'static str {
    match kind {
        AttemptKind::Mutation => "mutation",
        AttemptKind::Rewind => "rewind",
    }
}

fn operation_name(operation: JournalOperation) -> &'static str {
    match operation {
        JournalOperation::Write => "write",
        JournalOperation::Edit => "edit",
        JournalOperation::Delete => "delete",
        JournalOperation::Rewind => "rewind",
    }
}

fn transition_value(record: &JournalRecord, journal_sha256: &str) -> Value {
    json!({
        "schemaVersion":PROTOCOL_VERSION,
        "attemptId":record.attempt_id.as_str(),
        "checkpointId":record.checkpoint_id.as_str(),
        "attemptKind":attempt_kind_name(record.attempt_kind),
        "operation":operation_name(record.operation),
        "path":record.path.as_str(),
        "before":public_image(&record.before),
        "after":public_image(&record.after),
        "journalSha256":journal_sha256,
    })
}

fn recovery_value(record: &JournalRecord, journal_sha256: &str, observed: ObservedImage) -> Value {
    let (state, current, reason) = match observed {
        ObservedImage::Known(current) if image_matches(&current, &record.after) => {
            ("complete", public_image(&current), None)
        }
        ObservedImage::Known(current) if image_matches(&current, &record.before) => {
            ("partial", public_image(&current), None)
        }
        ObservedImage::Known(current) => (
            "uncertain",
            public_image(&current),
            Some("current image diverges from both journaled images".to_owned()),
        ),
        ObservedImage::Unknown(reason) => ("uncertain", json!({"kind":"unknown"}), Some(reason)),
    };
    let mut value = json!({
        "schemaVersion":PROTOCOL_VERSION,
        "attemptId":record.attempt_id.as_str(),
        "checkpointId":record.checkpoint_id.as_str(),
        "attemptKind":attempt_kind_name(record.attempt_kind),
        "path":record.path.as_str(),
        "state":state,
        "current":current,
        "journalSha256":journal_sha256,
    });
    if let Some(reason) = reason {
        value["reason"] = Value::String(reason);
    }
    value
}

fn record_file_name(attempt_id: &str) -> String {
    format!("record-{}.json", digest(attempt_id.as_bytes()))
}

fn blob_file_name(sha256: &str) -> String {
    format!("blob-{sha256}")
}

fn read_internal_optional(
    directory: &File,
    name: &OsStr,
    maximum: usize,
    cancelled: &AtomicBool,
) -> FsResult<Option<Vec<u8>>> {
    let mut file = match open_regular(directory, name) {
        Ok(file) => file,
        Err(error) if error.code == "NOT_FOUND" => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata().map_err(|error| FsError::io(&error))?;
    if metadata.len() > maximum as u64 {
        return Err(FsError::new(
            "CHECKPOINT_CORRUPT",
            "Checkpoint file exceeds its byte limit",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancelled(cancelled)?;
        let count = file
            .read(&mut buffer)
            .map_err(|error| FsError::io(&error))?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > maximum {
            return Err(FsError::new(
                "CHECKPOINT_CORRUPT",
                "Checkpoint file exceeds its byte limit",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(Some(bytes))
}

fn write_internal_once(directory: &File, name: &OsStr, bytes: &[u8]) -> FsResult<()> {
    let (temporary_name, mut temporary) = create_temporary(directory)?;
    let operation = (|| -> FsResult<()> {
        for chunk in bytes.chunks(64 * 1024) {
            temporary
                .write_all(chunk)
                .map_err(|error| FsError::io(&error))?;
        }
        temporary.sync_all().map_err(|error| FsError::io(&error))?;
        link_at(directory, &temporary_name, name).map_err(|error| {
            if error.code == "ALREADY_EXISTS" {
                FsError::new("CHECKPOINT_EXISTS", "Checkpoint file already exists")
            } else {
                error
            }
        })?;
        unlink_at(directory, &temporary_name, false)?;
        sync_parent(directory)?;
        Ok(())
    })();
    let _ = unlink_at(directory, &temporary_name, false);
    operation
}

fn checkpoint_directory_usage(directory: &File) -> FsResult<(usize, u64)> {
    // SAFETY: `dup` creates a descriptor owned by `fdopendir`, which `closedir` closes.
    let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
    if duplicate < 0 {
        return Err(FsError::io(&std::io::Error::last_os_error()));
    }
    // SAFETY: `duplicate` is a valid owned directory descriptor.
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        // SAFETY: `fdopendir` failed and did not take ownership of `duplicate`.
        unsafe { libc::close(duplicate) };
        return Err(FsError::io(&std::io::Error::last_os_error()));
    }
    let result = (|| -> FsResult<(usize, u64)> {
        let mut count = 0usize;
        let mut bytes = 0u64;
        loop {
            // SAFETY: `stream` remains live until the enclosing scope closes it.
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            // SAFETY: `readdir` returned a live NUL-terminated name within `entry`.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: `name`, `status`, and the directory descriptor remain valid for this call.
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    status.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(FsError::new(
                    "CHECKPOINT_CORRUPT",
                    "Checkpoint storage changed during validation",
                ));
            }
            // SAFETY: successful `fstatat` initialized `status`.
            let status = unsafe { status.assume_init() };
            if status.st_mode & libc::S_IFMT != libc::S_IFREG || status.st_size < 0 {
                return Err(FsError::new(
                    "CHECKPOINT_CORRUPT",
                    "Checkpoint storage contains an invalid entry",
                ));
            }
            count = count.checked_add(1).ok_or_else(|| {
                FsError::new(
                    "CHECKPOINT_STORAGE_FULL",
                    "Checkpoint storage limit reached",
                )
            })?;
            bytes = bytes.checked_add(status.st_size as u64).ok_or_else(|| {
                FsError::new(
                    "CHECKPOINT_STORAGE_FULL",
                    "Checkpoint storage limit reached",
                )
            })?;
        }
        Ok((count, bytes))
    })();
    // SAFETY: `stream` is live and `closedir` releases it and its duplicated descriptor.
    unsafe { libc::closedir(stream) };
    result
}

fn ensure_checkpoint_capacity(
    directory: &File,
    additional_files: usize,
    additional_bytes: u64,
) -> FsResult<()> {
    let (files, bytes) = checkpoint_directory_usage(directory)?;
    if files
        .checked_add(additional_files)
        .is_none_or(|value| value > MAX_CHECKPOINT_STORAGE_FILES)
        || bytes
            .checked_add(additional_bytes)
            .is_none_or(|value| value > MAX_CHECKPOINT_STORAGE_BYTES)
    {
        return Err(FsError::new(
            "CHECKPOINT_STORAGE_FULL",
            "Checkpoint storage limit reached",
        ));
    }
    Ok(())
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: &Value) -> FsResult<T> {
    serde_json::from_value(params.clone())
        .map_err(|_| FsError::invalid("Method parameters are invalid"))
}

fn validate_sha(value: &str) -> FsResult<()> {
    if value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        Ok(())
    } else {
        Err(FsError::invalid(
            "expectedSha256 must be a lowercase SHA-256 digest",
        ))
    }
}

fn validate_optional_sha(value: Option<&str>) -> FsResult<()> {
    match value {
        Some(value) => validate_sha(value),
        None => Ok(()),
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> FsResult<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(FsError::new(
            "CANCELLED",
            "File operation cancelled before commit",
        ))
    } else {
        Ok(())
    }
}

fn assert_precondition(current: Option<&Snapshot>, expected: Option<&str>) -> FsResult<()> {
    match (current, expected) {
        (None, None) => Ok(()),
        (Some(_), None) => Err(FsError::new("ALREADY_EXISTS", "Create precondition failed")),
        (None, Some(_)) => Err(FsError::new(
            "PRECONDITION_FAILED",
            "File precondition failed",
        )),
        (Some(current), Some(expected)) if current.sha256 == expected => Ok(()),
        (Some(_), Some(_)) => Err(FsError::new(
            "PRECONDITION_FAILED",
            "File precondition failed",
        )),
    }
}

fn assert_same_snapshot(before: Option<&Snapshot>, after: Option<&Snapshot>) -> FsResult<()> {
    if before.map(|value| (&value.sha256, value.mode))
        == after.map(|value| (&value.sha256, value.mode))
    {
        Ok(())
    } else {
        Err(FsError::new(
            "PRECONDITION_FAILED",
            "File changed before commit",
        ))
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn c_name(value: &OsStr) -> FsResult<CString> {
    CString::new(value.as_bytes()).map_err(|_| FsError::invalid_path())
}

fn open_directory(parent: &File, name: &OsStr) -> FsResult<File> {
    let name = c_name(name)?;
    // SAFETY: `name` is a live NUL-terminated string and `parent` owns a valid descriptor.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if is_symlink(parent.as_raw_fd(), &name) {
            return Err(FsError::new(
                "SYMLINK_FORBIDDEN",
                "File path cannot traverse a symbolic link",
            ));
        }
        return Err(FsError::io(&error));
    }
    // SAFETY: `openat` returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn open_regular(parent: &File, name: &OsStr) -> FsResult<File> {
    let name = c_name(name)?;
    // SAFETY: `name` is a live NUL-terminated string and `parent` owns a valid descriptor.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(FsError::io(&std::io::Error::last_os_error()));
    }
    // SAFETY: `openat` returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file.metadata().map_err(|error| FsError::io(&error))?;
    if metadata.file_type().is_symlink() {
        return Err(FsError::new(
            "SYMLINK_FORBIDDEN",
            "File path cannot traverse a symbolic link",
        ));
    }
    if metadata.file_type().is_dir()
        || metadata.file_type().is_socket()
        || metadata.file_type().is_fifo()
        || metadata.file_type().is_block_device()
        || metadata.file_type().is_char_device()
    {
        return Err(FsError::new(
            "NOT_REGULAR_FILE",
            "File path must identify a regular file",
        ));
    }
    Ok(file)
}

fn is_symlink(parent: RawFd, name: &CString) -> bool {
    let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: pointers and descriptor are valid for the duration of this call.
    let result = unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            status.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return false;
    }
    // SAFETY: successful `fstatat` initialized `status`.
    let status = unsafe { status.assume_init() };
    status.st_mode & libc::S_IFMT == libc::S_IFLNK
}

fn create_temporary(parent: &File) -> FsResult<(OsString, File)> {
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = OsString::from(format!(
            ".octocode-fs-{}-{sequence}.tmp",
            std::process::id()
        ));
        let c_name = c_name(&name)?;
        // SAFETY: `c_name` and `parent` remain valid for the call.
        let descriptor = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                c_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if descriptor >= 0 {
            // SAFETY: `openat` returned a new owned descriptor.
            return Ok((name, unsafe { File::from_raw_fd(descriptor) }));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(FsError::io(&error));
        }
    }
    Err(FsError::new(
        "IO_FAILURE",
        "Unable to allocate temporary file",
    ))
}

fn chmod(descriptor: RawFd, mode: u32) -> FsResult<()> {
    // SAFETY: `descriptor` is owned by the caller and `fchmod` does not retain it.
    if unsafe { libc::fchmod(descriptor, mode as libc::mode_t) } == 0 {
        Ok(())
    } else {
        Err(FsError::io(&std::io::Error::last_os_error()))
    }
}

fn sync_parent(parent: &File) -> FsResult<bool> {
    match parent.sync_all() {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EINVAL) | Some(libc::ENOTSUP)
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(FsError::io(&error)),
    }
}

fn rename_at(parent: &File, from: &OsStr, to: &OsStr) -> FsResult<()> {
    let from = c_name(from)?;
    let to = c_name(to)?;
    // SAFETY: both names and the directory descriptor remain valid for the call.
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
        )
    } == 0
    {
        Ok(())
    } else {
        Err(FsError::io(&std::io::Error::last_os_error()))
    }
}

fn mkdir_at(parent: &File, name: &OsStr, mode: u32) -> FsResult<()> {
    let name = c_name(name)?;
    // SAFETY: `name` and the directory descriptor remain valid for the call.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), mode as libc::mode_t) } == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EEXIST) {
            Err(FsError::new("ALREADY_EXISTS", "Directory already exists"))
        } else {
            Err(FsError::io(&error))
        }
    }
}

fn link_at(parent: &File, from: &OsStr, to: &OsStr) -> FsResult<()> {
    let from = c_name(from)?;
    let to = c_name(to)?;
    // SAFETY: both names and the directory descriptor remain valid for the call.
    if unsafe {
        libc::linkat(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
            0,
        )
    } == 0
    {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EEXIST) {
            Err(FsError::new("ALREADY_EXISTS", "Create precondition failed"))
        } else {
            Err(FsError::io(&error))
        }
    }
}

fn unlink_at(parent: &File, name: &OsStr, directory: bool) -> FsResult<()> {
    let name = c_name(name)?;
    let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
    // SAFETY: `name` and the directory descriptor remain valid for the call.
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } == 0 {
        Ok(())
    } else {
        Err(FsError::io(&std::io::Error::last_os_error()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    const ONE_MIB: usize = 1024 * 1024;

    fn error_code(result: FsResult<serde_json::Value>) -> &'static str {
        result.expect_err("operation unexpectedly succeeded").code
    }

    #[test]
    fn create_read_hash_replace_and_delete_enforce_sha_preconditions() {
        let root = tempdir().unwrap();
        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();

        let created = service
            .dispatch(
                "fs.replace",
                &json!({"path":"nested.txt","contentBase64":"aGVsbG8=","expectedSha256":null,"maxBytes":ONE_MIB}),
            )
            .unwrap();
        assert_eq!(created["path"], "nested.txt");
        assert_eq!(created["bytes"], 5);
        assert_eq!(created["previousSha256"], serde_json::Value::Null);
        let first_sha = created["sha256"].as_str().unwrap().to_owned();

        assert_eq!(
            error_code(service.dispatch(
                "fs.replace",
                &json!({"path":"nested.txt","contentBase64":"bmV3","expectedSha256":null,"maxBytes":ONE_MIB}),
            )),
            "ALREADY_EXISTS"
        );

        let read = service
            .dispatch("fs.read", &json!({"path":"nested.txt","maxBytes":ONE_MIB}))
            .unwrap();
        assert_eq!(read["contentBase64"], "aGVsbG8=");
        assert_eq!(read["sha256"], first_sha);

        let hashed = service
            .dispatch("fs.hash", &json!({"path":"nested.txt","maxBytes":ONE_MIB}))
            .unwrap();
        assert_eq!(hashed["sha256"], first_sha);
        assert!(hashed.get("contentBase64").is_none());

        assert_eq!(
            error_code(service.dispatch(
                "fs.replace",
                &json!({"path":"nested.txt","contentBase64":"bmV3","expectedSha256":"0000000000000000000000000000000000000000000000000000000000000000","maxBytes":ONE_MIB}),
            )),
            "PRECONDITION_FAILED"
        );

        let replaced = service
            .dispatch(
                "fs.replace",
                &json!({"path":"nested.txt","contentBase64":"bmV3","expectedSha256":first_sha,"maxBytes":ONE_MIB}),
            )
            .unwrap();
        let second_sha = replaced["sha256"].as_str().unwrap().to_owned();
        assert_eq!(replaced["previousSha256"], first_sha);

        assert_eq!(
            error_code(service.dispatch(
                "fs.delete",
                &json!({"path":"nested.txt","expectedSha256":"0000000000000000000000000000000000000000000000000000000000000000","maxBytes":ONE_MIB}),
            )),
            "PRECONDITION_FAILED"
        );
        let deleted = service
            .dispatch(
                "fs.delete",
                &json!({"path":"nested.txt","expectedSha256":second_sha,"maxBytes":ONE_MIB}),
            )
            .unwrap();
        assert_eq!(deleted["committed"], true);
        assert_eq!(
            error_code(
                service.dispatch("fs.read", &json!({"path":"nested.txt","maxBytes":ONE_MIB}))
            ),
            "NOT_FOUND"
        );
    }

    #[test]
    fn rejects_absolute_parent_and_symlink_paths_without_disclosing_the_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret"), b"secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();

        for path in ["/absolute", "../outside", "a/../../outside", "."] {
            let error = service
                .dispatch("fs.read", &json!({"path":path,"maxBytes":ONE_MIB}))
                .unwrap_err();
            assert_eq!(error.code, "INVALID_PATH");
            assert!(!error
                .message
                .contains(root.path().to_string_lossy().as_ref()));
        }
        #[cfg(unix)]
        assert_eq!(
            error_code(service.dispatch(
                "fs.read",
                &json!({"path":"escape/secret","maxBytes":ONE_MIB})
            )),
            "SYMLINK_FORBIDDEN"
        );
    }

    #[test]
    fn bounds_io_preserves_replaced_permissions_and_cleans_temporary_files() {
        let root = tempdir().unwrap();
        let path = root.path().join("mode.txt");
        fs::write(&path, b"old").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let service = WorkspaceFs::open(root.path(), 4).unwrap();
        let old = service
            .dispatch("fs.hash", &json!({"path":"mode.txt","maxBytes":4}))
            .unwrap();

        assert_eq!(
            error_code(service.dispatch(
                "fs.replace",
                &json!({
                    "path":"mode.txt",
                    "contentBase64":"MTIzNDU=",
                    "expectedSha256":old["sha256"],
                    "maxBytes":4
                })
            )),
            "TOO_LARGE"
        );
        assert_eq!(fs::read(&path).unwrap(), b"old");

        service
            .dispatch(
                "fs.replace",
                &json!({
                    "path":"mode.txt",
                    "contentBase64":"bmV3",
                    "expectedSha256":old["sha256"],
                    "maxBytes":4
                }),
            )
            .unwrap();
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let names: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("mode.txt")]);

        fs::write(root.path().join("large"), b"12345").unwrap();
        assert_eq!(
            error_code(service.dispatch("fs.read", &json!({"path":"large","maxBytes":4}))),
            "TOO_LARGE"
        );
        assert_eq!(
            error_code(service.dispatch("fs.hash", &json!({"path":"large","maxBytes":4}))),
            "TOO_LARGE"
        );
    }

    #[test]
    fn protocol_validation_is_strict_and_errors_are_stable() {
        let root = tempdir().unwrap();
        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();
        assert_eq!(
            error_code(service.dispatch("missing", &json!({}))),
            "METHOD_NOT_FOUND"
        );
        assert_eq!(
            error_code(service.dispatch(
                "fs.read",
                &json!({"path":"x","maxBytes":ONE_MIB,"extra":true})
            )),
            "INVALID_REQUEST"
        );
        assert_eq!(
            error_code(service.dispatch("fs.read", &json!({"path":"x"}))),
            "INVALID_REQUEST"
        );
        assert_eq!(
            error_code(service.dispatch("fs.read", &json!({"path":"x","maxBytes":ONE_MIB + 1}),)),
            "INVALID_REQUEST"
        );
        assert_eq!(
            error_code(service.dispatch(
                "fs.replace",
                &json!({
                    "path":"x","contentBase64":"MTIzNDU=","expectedSha256":null,"maxBytes":4
                })
            )),
            "TOO_LARGE"
        );
        assert_eq!(
            error_code(service.dispatch(
                "fs.replace",
                &json!({
                    "path":"x","contentBase64":"%%%","expectedSha256":null,"maxBytes":ONE_MIB
                })
            )),
            "INVALID_REQUEST"
        );
        assert_eq!(
            error_code(service.dispatch(
                "fs.delete",
                &json!({
                    "path":"x","expectedSha256":"BAD","maxBytes":ONE_MIB
                })
            )),
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn cancellation_before_commit_never_mutates_the_target() {
        let root = tempdir().unwrap();
        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();
        let cancelled = AtomicBool::new(true);
        let error = service
            .dispatch_with_cancel(
                "fs.replace",
                &json!({"path":"cancelled.txt","contentBase64":"bmV2ZXI=","expectedSha256":null,"maxBytes":ONE_MIB}),
                &cancelled,
            )
            .unwrap_err();
        assert_eq!(error.code, "CANCELLED");
        assert!(!error.committed);
        assert!(!root.path().join("cancelled.txt").exists());
    }

    #[test]
    fn authorizes_only_contained_regular_external_paths() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("input.mp4"), b"media").unwrap();
        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();
        let input = service
            .dispatch(
                "fs.authorizeExternalPath",
                &json!({"path":"input.mp4","kind":"input"}),
            )
            .unwrap();
        assert_eq!(input["path"], "input.mp4");
        assert_eq!(input["kind"], "input");
        assert_eq!(
            input["hostPath"],
            std::fs::canonicalize(root.path())
                .unwrap()
                .join("input.mp4")
                .to_string_lossy()
                .as_ref()
        );
        let output = service
            .dispatch(
                "fs.authorizeExternalPath",
                &json!({"path":"output.mp4","kind":"output"}),
            )
            .unwrap();
        assert_eq!(output["kind"], "output");
        assert_eq!(
            error_code(service.dispatch(
                "fs.authorizeExternalPath",
                &json!({"path":"missing.mp4","kind":"input"}),
            )),
            "NOT_FOUND"
        );
        assert_eq!(
            error_code(service.dispatch(
                "fs.authorizeExternalPath",
                &json!({"path":"../outside.mp4","kind":"output"}),
            )),
            "INVALID_PATH"
        );
    }

    #[test]
    fn checkpoint_journal_survives_restart_and_rewind_restores_bytes_and_mode() {
        let root = tempdir().unwrap();
        let path = root.path().join("mode.txt");
        fs::write(&path, b"before").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        let prepared = {
            let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();
            service
                .dispatch(
                    "fs.checkpoint.prepareReplace",
                    &json!({
                        "checkpointId":"checkpoint-edit-1",
                        "operation":"edit",
                        "path":"mode.txt",
                        "contentBase64":"YWZ0ZXI=",
                        "expectedSha256":digest(b"before"),
                        "maxBytes":ONE_MIB
                    }),
                )
                .unwrap()
        };
        assert_eq!(prepared["attemptKind"], "mutation");
        assert_eq!(prepared["before"]["mode"], 0o640);
        assert_eq!(prepared["after"]["sha256"], digest(b"after"));
        assert_eq!(fs::read(&path).unwrap(), b"before");

        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();
        let partial = service
            .dispatch(
                "fs.checkpoint.recover",
                &json!({"attemptId":"checkpoint-edit-1","maxBytes":ONE_MIB}),
            )
            .unwrap();
        assert_eq!(partial["state"], "partial");
        let complete = service
            .dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"checkpoint-edit-1","maxBytes":ONE_MIB}),
            )
            .unwrap();
        assert_eq!(complete["state"], "complete");
        assert_eq!(fs::read(&path).unwrap(), b"after");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );

        let rewind = service
            .dispatch(
                "fs.checkpoint.prepareRewind",
                &json!({
                    "checkpointId":"checkpoint-edit-1",
                    "rewindId":"rewind-edit-1",
                    "path":"mode.txt",
                    "expectedPostimageSha256":digest(b"after"),
                    "maxBytes":ONE_MIB
                }),
            )
            .unwrap();
        assert_eq!(rewind["attemptKind"], "rewind");
        assert_eq!(
            service
                .dispatch(
                    "fs.checkpoint.recover",
                    &json!({"attemptId":"rewind-edit-1","maxBytes":ONE_MIB}),
                )
                .unwrap()["state"],
            "partial"
        );
        service
            .dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"rewind-edit-1","maxBytes":ONE_MIB}),
            )
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"before");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            service
                .dispatch(
                    "fs.checkpoint.recover",
                    &json!({"attemptId":"rewind-edit-1","maxBytes":ONE_MIB}),
                )
                .unwrap()["state"],
            "complete"
        );
    }

    #[test]
    fn checkpoint_rewind_handles_create_delete_and_digest_fences_divergence() {
        let root = tempdir().unwrap();
        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();
        service
            .dispatch(
                "fs.checkpoint.prepareReplace",
                &json!({
                    "checkpointId":"checkpoint-create-1",
                    "operation":"write",
                    "path":"created.txt",
                    "contentBase64":"Y3JlYXRlZA==",
                    "expectedSha256":null,
                    "maxBytes":ONE_MIB
                }),
            )
            .unwrap();
        service
            .dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"checkpoint-create-1","maxBytes":ONE_MIB}),
            )
            .unwrap();
        service
            .dispatch(
                "fs.checkpoint.prepareRewind",
                &json!({
                    "checkpointId":"checkpoint-create-1",
                    "rewindId":"rewind-create-1",
                    "path":"created.txt",
                    "expectedPostimageSha256":digest(b"created"),
                    "maxBytes":ONE_MIB
                }),
            )
            .unwrap();
        service
            .dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"rewind-create-1","maxBytes":ONE_MIB}),
            )
            .unwrap();
        assert!(!root.path().join("created.txt").exists());

        let deleted_path = root.path().join("deleted.txt");
        fs::write(&deleted_path, b"deleted").unwrap();
        fs::set_permissions(&deleted_path, fs::Permissions::from_mode(0o604)).unwrap();
        service
            .dispatch(
                "fs.checkpoint.prepareDelete",
                &json!({
                    "checkpointId":"checkpoint-delete-1",
                    "path":"deleted.txt",
                    "expectedSha256":digest(b"deleted"),
                    "maxBytes":ONE_MIB
                }),
            )
            .unwrap();
        service
            .dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"checkpoint-delete-1","maxBytes":ONE_MIB}),
            )
            .unwrap();
        service
            .dispatch(
                "fs.checkpoint.prepareRewind",
                &json!({
                    "checkpointId":"checkpoint-delete-1",
                    "rewindId":"rewind-delete-1",
                    "path":"deleted.txt",
                    "expectedPostimageSha256":null,
                    "maxBytes":ONE_MIB
                }),
            )
            .unwrap();
        service
            .dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"rewind-delete-1","maxBytes":ONE_MIB}),
            )
            .unwrap();
        assert_eq!(fs::read(&deleted_path).unwrap(), b"deleted");
        assert_eq!(
            fs::metadata(&deleted_path).unwrap().permissions().mode() & 0o777,
            0o604
        );

        service
            .dispatch(
                "fs.checkpoint.prepareReplace",
                &json!({
                    "checkpointId":"checkpoint-diverge-1",
                    "operation":"edit",
                    "path":"deleted.txt",
                    "contentBase64":"bmV4dA==",
                    "expectedSha256":digest(b"deleted"),
                    "maxBytes":ONE_MIB
                }),
            )
            .unwrap();
        fs::write(&deleted_path, b"external").unwrap();
        assert_eq!(
            error_code(service.dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"checkpoint-diverge-1","maxBytes":ONE_MIB}),
            )),
            "PRECONDITION_FAILED"
        );
        assert_eq!(
            service
                .dispatch(
                    "fs.checkpoint.recover",
                    &json!({"attemptId":"checkpoint-diverge-1","maxBytes":ONE_MIB}),
                )
                .unwrap()["state"],
            "uncertain"
        );
    }

    #[test]
    fn checkpoint_protocol_is_strict_and_detects_corrupt_content_addressed_blobs() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.txt"), b"before").unwrap();
        let service = WorkspaceFs::open(root.path(), ONE_MIB).unwrap();
        assert_eq!(
            error_code(service.dispatch(
                "fs.checkpoint.prepareDelete",
                &json!({
                    "checkpointId":"bad-extra",
                    "path":"a.txt",
                    "expectedSha256":digest(b"before"),
                    "maxBytes":ONE_MIB,
                    "extra":true
                }),
            )),
            "INVALID_REQUEST"
        );
        service
            .dispatch(
                "fs.checkpoint.prepareDelete",
                &json!({
                    "checkpointId":"checkpoint-corrupt-1",
                    "path":"a.txt",
                    "expectedSha256":digest(b"before"),
                    "maxBytes":ONE_MIB
                }),
            )
            .unwrap();
        let journal = root.path().join(".octocode-agent-checkpoints-v1");
        let blob = fs::read_dir(&journal)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("blob-")
            })
            .unwrap();
        fs::write(blob, b"tampered").unwrap();
        assert_eq!(
            error_code(service.dispatch(
                "fs.checkpoint.apply",
                &json!({"attemptId":"checkpoint-corrupt-1","maxBytes":ONE_MIB}),
            )),
            "CHECKPOINT_CORRUPT"
        );
    }
}
