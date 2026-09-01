use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions, Permissions};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

pub const PROTOCOL_VERSION: i64 = 1;
pub const MAX_CONTENT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

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
        use std::io::ErrorKind;
        match error.kind() {
            ErrorKind::NotFound => Self::new("NOT_FOUND", "File does not exist"),
            ErrorKind::PermissionDenied => {
                Self::new("PERMISSION_DENIED", "File operation was not permitted")
            }
            ErrorKind::AlreadyExists => {
                Self::new("PRECONDITION_FAILED", "File changed before commit")
            }
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
    path: PathBuf,
}

impl RelativePath {
    fn parse(value: &str) -> FsResult<Self> {
        if value.is_empty() || value.len() > 4096 {
            return Err(FsError::invalid_path());
        }
        let mut clean = PathBuf::new();
        for component in Path::new(value).components() {
            match component {
                Component::Normal(value) => clean.push(value),
                _ => return Err(FsError::invalid_path()),
            }
        }
        if clean.as_os_str().is_empty() {
            return Err(FsError::invalid_path());
        }
        Ok(Self {
            display: clean.to_string_lossy().replace('\\', "/"),
            path: clean,
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
    permissions: Permissions,
}

#[derive(Debug)]
pub struct WorkspaceFs {
    root: Dir,
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
        let root = Dir::open_ambient_dir(&root_path, ambient_authority())
            .map_err(|error| FsError::io(&error))?;
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
                Ok(
                    json!({"status":"ok","schemaVersion":PROTOCOL_VERSION,"maxBytes":self.max_bytes,"cancellation":"cooperative-before-commit"}),
                )
            }
            "fs.read" | "fs.hash" => {
                let input = parse_params::<PathParams>(params)?;
                let maximum = self.request_maximum(input.max_bytes)?;
                self.read(
                    &RelativePath::parse(&input.path)?,
                    method == "fs.read",
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
                let maximum_encoded = maximum.div_ceil(3) * 4;
                if input.content_base64.len() > maximum_encoded {
                    return Err(FsError::new(
                        "TOO_LARGE",
                        "File exceeds configured byte limit",
                    ));
                }
                let bytes = BASE64
                    .decode(&input.content_base64)
                    .map_err(|_| FsError::invalid("contentBase64 must be canonical base64"))?;
                if BASE64.encode(&bytes) != input.content_base64 {
                    return Err(FsError::invalid("contentBase64 must be canonical base64"));
                }
                if bytes.len() > maximum {
                    return Err(FsError::new(
                        "TOO_LARGE",
                        "File exceeds configured byte limit",
                    ));
                }
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
        let snapshot = self.snapshot(relative, maximum, cancelled)?;
        let mut result = json!({"path":relative.display,"bytes":snapshot.bytes.len(),"sha256":snapshot.sha256,"validUtf8":std::str::from_utf8(&snapshot.bytes).is_ok()});
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
        self.assert_parent_chain(relative)?;
        match self.root.symlink_metadata(&relative.path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(FsError::new(
                        "SYMLINK_FORBIDDEN",
                        "File path cannot traverse a symbolic link",
                    ));
                }
                if !metadata.file_type().is_file() {
                    return Err(FsError::new(
                        "NOT_REGULAR_FILE",
                        "File path must identify a regular file",
                    ));
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && matches!(kind, ExternalPathKind::Output) => {}
            Err(error) => return Err(FsError::io(&error)),
        }
        check_cancelled(cancelled)?;
        let kind_name = match kind {
            ExternalPathKind::Input => "input",
            ExternalPathKind::Output => "output",
        };
        Ok(json!({
            "path": relative.display,
            "hostPath": self.root_path.join(&relative.path).to_string_lossy(),
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
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        self.assert_parent_chain(relative)?;
        let current = match self.snapshot(relative, maximum, cancelled) {
            Ok(value) => Some(value),
            Err(error) if error.code == "NOT_FOUND" => None,
            Err(error) => return Err(error),
        };
        assert_precondition(current.as_ref(), expected)?;
        let temporary_path = self.temporary_path(relative);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut temporary = self
            .root
            .open_with(&temporary_path, &options)
            .map_err(|error| FsError::io(&error))?;
        let mut temporary_present = true;
        let operation = (|| -> FsResult<()> {
            if let Some(snapshot) = &current {
                temporary
                    .set_permissions(snapshot.permissions.clone())
                    .map_err(|error| FsError::io(&error))?;
            }
            for chunk in bytes.chunks(64 * 1024) {
                check_cancelled(cancelled)?;
                temporary
                    .write_all(chunk)
                    .map_err(|error| FsError::io(&error))?;
            }
            temporary.sync_all().map_err(|error| FsError::io(&error))?;
            check_cancelled(cancelled)?;
            let latest = match self.snapshot(relative, maximum, cancelled) {
                Ok(value) => Some(value),
                Err(error) if error.code == "NOT_FOUND" => None,
                Err(error) => return Err(error),
            };
            assert_same_snapshot(current.as_ref(), latest.as_ref())?;
            check_cancelled(cancelled)?;
            if expected.is_none() {
                self.root
                    .hard_link(&temporary_path, &self.root, &relative.path)
                    .map_err(|error| FsError::io(&error))?;
                self.root
                    .remove_file(&temporary_path)
                    .map_err(|error| FsError::io(&error).after_commit())?;
            } else {
                self.root
                    .rename(&temporary_path, &self.root, &relative.path)
                    .map_err(|error| FsError::io(&error))?;
            }
            temporary_present = false;
            Ok(())
        })();
        if temporary_present {
            let _ = self.root.remove_file(&temporary_path);
        }
        operation?;
        Ok(
            json!({"path":relative.display,"bytes":bytes.len(),"sha256":digest(bytes),"previousSha256":current.map(|value| value.sha256),"committed":true,"durability":"file-only"}),
        )
    }

    fn delete(
        &self,
        relative: &RelativePath,
        expected: &str,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Value> {
        check_cancelled(cancelled)?;
        self.assert_parent_chain(relative)?;
        let current = self.snapshot(relative, maximum, cancelled)?;
        assert_precondition(Some(&current), Some(expected))?;
        let latest = self.snapshot(relative, maximum, cancelled)?;
        assert_same_snapshot(Some(&current), Some(&latest))?;
        check_cancelled(cancelled)?;
        self.root
            .remove_file(&relative.path)
            .map_err(|error| FsError::io(&error))?;
        Ok(
            json!({"path":relative.display,"previousSha256":current.sha256,"committed":true,"durability":"best-effort-parent"}),
        )
    }

    fn snapshot(
        &self,
        relative: &RelativePath,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> FsResult<Snapshot> {
        self.assert_parent_chain(relative)?;
        let link_metadata = self
            .root
            .symlink_metadata(&relative.path)
            .map_err(|error| FsError::io(&error))?;
        if link_metadata.file_type().is_symlink() {
            return Err(FsError::new(
                "SYMLINK_FORBIDDEN",
                "File path cannot traverse a symbolic link",
            ));
        }
        if !link_metadata.file_type().is_file() {
            return Err(FsError::new(
                "NOT_REGULAR_FILE",
                "File path must identify a regular file",
            ));
        }
        if link_metadata.len() > maximum as u64 {
            return Err(FsError::new(
                "TOO_LARGE",
                "File exceeds configured byte limit",
            ));
        }
        let mut file = self
            .root
            .open(&relative.path)
            .map_err(|error| FsError::io(&error))?;
        let metadata = file.metadata().map_err(|error| FsError::io(&error))?;
        if !metadata.file_type().is_file() {
            return Err(FsError::new(
                "NOT_REGULAR_FILE",
                "File path must identify a regular file",
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
            permissions: metadata.permissions(),
        })
    }

    fn assert_parent_chain(&self, relative: &RelativePath) -> FsResult<()> {
        let mut prefix = PathBuf::new();
        let parent = relative.path.parent().unwrap_or_else(|| Path::new(""));
        for component in parent.components() {
            prefix.push(component.as_os_str());
            let metadata = self
                .root
                .symlink_metadata(&prefix)
                .map_err(|error| FsError::io(&error))?;
            if metadata.file_type().is_symlink() {
                return Err(FsError::new(
                    "SYMLINK_FORBIDDEN",
                    "File path cannot traverse a symbolic link",
                ));
            }
            if !metadata.file_type().is_dir() {
                return Err(FsError::new(
                    "INVALID_PATH",
                    "File parent must be a directory",
                ));
            }
        }
        Ok(())
    }

    fn temporary_path(&self, relative: &RelativePath) -> PathBuf {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!(".octocode-tmp-{}-{}", std::process::id(), sequence);
        relative
            .path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(name)
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

fn parse_params<T: for<'de> Deserialize<'de>>(params: &Value) -> FsResult<T> {
    serde_json::from_value(params.clone())
        .map_err(|_| FsError::invalid("Invalid method parameters"))
}

fn validate_sha(value: &str) -> FsResult<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
        Err(FsError::new("CANCELLED", "File operation was cancelled"))
    } else {
        Ok(())
    }
}

fn assert_precondition(current: Option<&Snapshot>, expected: Option<&str>) -> FsResult<()> {
    match (current, expected) {
        (None, None) => Ok(()),
        (Some(_), None) => Err(FsError::new("PRECONDITION_FAILED", "File already exists")),
        (Some(current), Some(expected)) if current.sha256 == expected => Ok(()),
        _ => Err(FsError::new(
            "PRECONDITION_FAILED",
            "File changed before commit",
        )),
    }
}

fn assert_same_snapshot(before: Option<&Snapshot>, after: Option<&Snapshot>) -> FsResult<()> {
    match (before, after) {
        (None, None) => Ok(()),
        (Some(before), Some(after)) if before.sha256 == after.sha256 => Ok(()),
        _ => Err(FsError::new(
            "PRECONDITION_FAILED",
            "File changed before commit",
        )),
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
