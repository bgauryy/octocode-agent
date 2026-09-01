#[allow(dead_code)]
#[path = "../../src/fs_service_windows.rs"]
mod portable;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use portable::{FsResult, WorkspaceFs};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use tempfile::tempdir;

fn code(result: FsResult<serde_json::Value>) -> &'static str {
    result.unwrap_err().code
}

#[test]
fn portable_backend_enforces_cas_across_the_full_file_lifecycle() {
    let workspace = tempdir().unwrap();
    let service = WorkspaceFs::open(workspace.path(), 1024 * 1024).unwrap();
    let first = b"portable-one";
    let first_sha = format!("{:x}", Sha256::digest(first));
    let created = service
        .dispatch(
            "fs.replace",
            &json!({
                "path":"nested.txt","contentBase64":BASE64.encode(first),
                "expectedSha256":null,"maxBytes":1024
            }),
        )
        .unwrap();
    assert_eq!(created["sha256"], first_sha);

    let read = service
        .dispatch("fs.read", &json!({"path":"nested.txt","maxBytes":1024}))
        .unwrap();
    assert_eq!(
        BASE64
            .decode(read["contentBase64"].as_str().unwrap())
            .unwrap(),
        first
    );
    assert_eq!(
        code(service.dispatch(
            "fs.replace",
            &json!({
                "path":"nested.txt","contentBase64":BASE64.encode(b"wrong"),
                "expectedSha256":null,"maxBytes":1024
            })
        )),
        "PRECONDITION_FAILED"
    );

    let second = b"portable-two";
    let second_sha = format!("{:x}", Sha256::digest(second));
    service
        .dispatch(
            "fs.replace",
            &json!({
                "path":"nested.txt","contentBase64":BASE64.encode(second),
                "expectedSha256":first_sha,"maxBytes":1024
            }),
        )
        .unwrap();
    service
        .dispatch(
            "fs.delete",
            &json!({
                "path":"nested.txt","expectedSha256":second_sha,"maxBytes":1024
            }),
        )
        .unwrap();
    assert!(!workspace.path().join("nested.txt").exists());
}

#[test]
fn portable_backend_rejects_escape_and_symlink_traversal() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
    let service = WorkspaceFs::open(workspace.path(), 1024 * 1024).unwrap();
    assert_eq!(
        code(service.dispatch("fs.read", &json!({"path":"../secret.txt","maxBytes":1024}))),
        "INVALID_PATH"
    );

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape")).unwrap();
        assert_eq!(
            code(service.dispatch(
                "fs.read",
                &json!({"path":"escape/secret.txt","maxBytes":1024})
            )),
            "SYMLINK_FORBIDDEN"
        );
    }
}
