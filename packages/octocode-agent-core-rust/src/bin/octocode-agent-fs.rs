#[cfg(any(unix, windows))]
#[cfg_attr(unix, path = "../fs_service.rs")]
#[cfg_attr(windows, path = "../fs_service_windows.rs")]
mod fs_service;

#[cfg(any(unix, windows))]
mod supported {
    use super::fs_service::{
        FsError, WorkspaceFs, MAX_CONTENT_BYTES, MAX_FRAME_BYTES, PROTOCOL_VERSION,
    };
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::env;
    use std::io::{self, BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    const MAX_ACTIVE_REQUESTS: usize = 4;

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        #[serde(rename = "schemaVersion")]
        schema_version: i64,
        id: Value,
        method: String,
        #[serde(default)]
        params: Value,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CancelParams {
        #[serde(rename = "requestId")]
        request_id: Value,
    }

    struct Options {
        workspace: PathBuf,
        max_bytes: usize,
    }

    fn options() -> Result<Options, ()> {
        let mut args = env::args_os().skip(1);
        let mut workspace = None;
        let mut max_bytes = 1024 * 1024;
        while let Some(flag) = args.next() {
            if flag == "--workspace" && workspace.is_none() {
                workspace = args.next().map(PathBuf::from);
            } else if flag == "--max-bytes" {
                max_bytes = args
                    .next()
                    .and_then(|value| value.to_str().and_then(|value| value.parse().ok()))
                    .ok_or(())?;
            } else {
                return Err(());
            }
        }
        let workspace = workspace.ok_or(())?;
        if !workspace.is_absolute() || max_bytes == 0 || max_bytes > MAX_CONTENT_BYTES {
            return Err(());
        }
        Ok(Options {
            workspace,
            max_bytes,
        })
    }

    fn request_key(id: &Value) -> Result<String, FsError> {
        let valid = id
            .as_str()
            .map(|value| !value.is_empty())
            .or_else(|| id.as_u64().map(|_| true))
            .unwrap_or(false);
        if !valid {
            return Err(FsError {
                code: "INVALID_REQUEST",
                message: "id must be a non-empty string or non-negative integer".into(),
                committed: false,
            });
        }
        serde_json::to_string(id).map_err(|_| FsError {
            code: "INVALID_REQUEST",
            message: "id is invalid".into(),
            committed: false,
        })
    }

    fn parse_request(bytes: &[u8]) -> Result<Request, FsError> {
        let request: Request = serde_json::from_slice(bytes).map_err(|_| FsError {
            code: "INVALID_REQUEST",
            message: "Request must be valid JSON".into(),
            committed: false,
        })?;
        if request.schema_version != PROTOCOL_VERSION {
            return Err(FsError {
                code: "UNSUPPORTED_SCHEMA_VERSION",
                message: "Unsupported schema version".into(),
                committed: false,
            });
        }
        request_key(&request.id)?;
        if request.method.is_empty() || !request.params.is_object() {
            return Err(FsError {
                code: "INVALID_REQUEST",
                message: "method and params are invalid".into(),
                committed: false,
            });
        }
        Ok(request)
    }

    fn error_response(id: Value, error: FsError) -> Value {
        json!({
            "schemaVersion":PROTOCOL_VERSION,
            "id":id,
            "ok":false,
            "error":{
                "code":error.code,
                "message":error.message,
                "committed":error.committed
            }
        })
    }

    fn success_response(id: Value, result: Value) -> Value {
        json!({"schemaVersion":PROTOCOL_VERSION,"id":id,"ok":true,"result":result})
    }

    fn write_response(output: &Mutex<io::Stdout>, response: &Value) -> io::Result<()> {
        let mut output = output
            .lock()
            .map_err(|_| io::Error::other("stdout lock poisoned"))?;
        serde_json::to_writer(&mut *output, response)?;
        output.write_all(b"\n")?;
        output.flush()
    }

    fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>, FsError>>> {
        let mut frame = Vec::new();
        let mut overflow = false;
        let mut observed = false;
        loop {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                if !observed {
                    return Ok(None);
                }
                break;
            }
            observed = true;
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            let payload = newline.map_or(available, |index| &available[..index]);
            if !overflow {
                if frame.len() + payload.len() > MAX_FRAME_BYTES {
                    overflow = true;
                    frame.clear();
                } else {
                    frame.extend_from_slice(payload);
                }
            }
            reader.consume(consumed);
            if newline.is_some() {
                break;
            }
        }
        if overflow {
            return Ok(Some(Err(FsError {
                code: "FRAME_TOO_LARGE",
                message: "Request frame exceeds the protocol limit".into(),
                committed: false,
            })));
        }
        if frame.last() == Some(&b'\r') {
            frame.pop();
        }
        Ok(Some(Ok(frame)))
    }

    fn reserve_slot(active_count: &AtomicUsize) -> bool {
        active_count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_ACTIVE_REQUESTS).then_some(current + 1)
            })
            .is_ok()
    }

    fn run() -> Result<(), ()> {
        let options = options()?;
        let service =
            Arc::new(WorkspaceFs::open(options.workspace, options.max_bytes).map_err(|_| ())?);
        let output = Arc::new(Mutex::new(io::stdout()));
        let active = Arc::new(Mutex::new(HashMap::<String, Arc<AtomicBool>>::new()));
        let active_count = Arc::new(AtomicUsize::new(0));
        let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();
        let stdin = io::stdin();
        let mut input = BufReader::new(stdin.lock());

        while let Some(frame) = read_frame(&mut input).map_err(|_| ())? {
            let mut index = 0;
            while index < workers.len() {
                if workers[index].is_finished() {
                    let worker = workers.swap_remove(index);
                    let _ = worker.join();
                } else {
                    index += 1;
                }
            }
            let request = match frame.and_then(|bytes| parse_request(&bytes)) {
                Ok(request) => request,
                Err(error) => {
                    write_response(&output, &error_response(Value::Null, error)).map_err(|_| ())?;
                    continue;
                }
            };
            if request.method == "cancel" {
                let cancel_key = request_key(&request.id).map_err(|_| ())?;
                if active.lock().map_err(|_| ())?.contains_key(&cancel_key) {
                    write_response(
                        &output,
                        &error_response(
                            request.id,
                            FsError {
                                code: "DUPLICATE_REQUEST_ID",
                                message: "Request id is already active".into(),
                                committed: false,
                            },
                        ),
                    )
                    .map_err(|_| ())?;
                    continue;
                }
                let response = match serde_json::from_value::<CancelParams>(request.params) {
                    Ok(params) => match request_key(&params.request_id) {
                        Ok(key) => {
                            let signal = active.lock().map_err(|_| ())?.get(&key).cloned();
                            if let Some(signal) = signal {
                                signal.store(true, Ordering::Release);
                                success_response(
                                    request.id,
                                    json!({"accepted":true,"requestId":params.request_id}),
                                )
                            } else {
                                success_response(
                                    request.id,
                                    json!({"accepted":false,"requestId":params.request_id}),
                                )
                            }
                        }
                        Err(error) => error_response(request.id, error),
                    },
                    Err(_) => error_response(
                        request.id,
                        FsError {
                            code: "INVALID_REQUEST",
                            message: "Cancel parameters are invalid".into(),
                            committed: false,
                        },
                    ),
                };
                write_response(&output, &response).map_err(|_| ())?;
                continue;
            }

            let key = request_key(&request.id).map_err(|_| ())?;
            let signal = Arc::new(AtomicBool::new(false));
            {
                let mut requests = active.lock().map_err(|_| ())?;
                if requests.contains_key(&key) {
                    let response = error_response(
                        request.id,
                        FsError {
                            code: "DUPLICATE_REQUEST_ID",
                            message: "Request id is already active".into(),
                            committed: false,
                        },
                    );
                    drop(requests);
                    write_response(&output, &response).map_err(|_| ())?;
                    continue;
                }
                if !reserve_slot(&active_count) {
                    let response = error_response(
                        request.id,
                        FsError {
                            code: "BUSY",
                            message: "Filesystem service is at capacity".into(),
                            committed: false,
                        },
                    );
                    drop(requests);
                    write_response(&output, &response).map_err(|_| ())?;
                    continue;
                }
                requests.insert(key.clone(), Arc::clone(&signal));
            }

            let service = Arc::clone(&service);
            let output = Arc::clone(&output);
            let active = Arc::clone(&active);
            let active_count = Arc::clone(&active_count);
            workers.push(thread::spawn(move || {
                let response =
                    match service.dispatch_with_cancel(&request.method, &request.params, &signal) {
                        Ok(result) => success_response(request.id, result),
                        Err(error) => error_response(request.id, error),
                    };
                let _ = write_response(&output, &response);
                if let Ok(mut requests) = active.lock() {
                    requests.remove(&key);
                }
                active_count.fetch_sub(1, Ordering::AcqRel);
            }));
        }
        for worker in workers {
            let _ = worker.join();
        }
        Ok(())
    }

    pub(super) fn run_main() {
        if run().is_err() {
            eprintln!("filesystem service failed");
            std::process::exit(1);
        }
    }

    #[cfg(test)]
    mod protocol_tests {
        use super::*;
        use std::io::Cursor;

        #[test]
        fn bounded_reader_accepts_maximum_sized_frames_and_recovers_after_overflow() {
            let maximum = vec![b'a'; MAX_FRAME_BYTES];
            let mut input = maximum.clone();
            input.push(b'\n');
            let mut reader = Cursor::new(input);
            assert_eq!(
                read_frame(&mut reader).unwrap().unwrap().unwrap().len(),
                MAX_FRAME_BYTES
            );

            let mut oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
            oversized.extend_from_slice(b"\n{}\n");
            let mut reader = Cursor::new(oversized);
            assert_eq!(
                read_frame(&mut reader).unwrap().unwrap().unwrap_err().code,
                "FRAME_TOO_LARGE"
            );
            assert_eq!(read_frame(&mut reader).unwrap().unwrap().unwrap(), b"{}");
        }

        #[test]
        fn request_envelope_is_strict_and_versioned() {
            let valid = br#"{"schemaVersion":1,"id":"r1","method":"health","params":{}}"#;
            assert_eq!(parse_request(valid).unwrap().method, "health");
            let unknown =
                br#"{"schemaVersion":1,"id":"r1","method":"health","params":{},"extra":true}"#;
            assert_eq!(parse_request(unknown).unwrap_err().code, "INVALID_REQUEST");
            let future = br#"{"schemaVersion":2,"id":"r1","method":"health","params":{}}"#;
            assert_eq!(
                parse_request(future).unwrap_err().code,
                "UNSUPPORTED_SCHEMA_VERSION"
            );
        }
    }
}

#[cfg(any(unix, windows))]
fn main() {
    supported::run_main();
}

#[cfg(not(any(unix, windows)))]
const UNSUPPORTED_PLATFORM: &str =
    "octocode-agent-fs is unsupported on this target; supported target families: unix and windows";

#[cfg(not(any(unix, windows)))]
fn main() {
    eprintln!("{UNSUPPORTED_PLATFORM}");
    std::process::exit(2);
}

#[cfg(all(test, not(any(unix, windows))))]
mod unsupported_target_tests {
    use super::*;

    #[test]
    fn unsupported_target_message_is_actionable() {
        assert!(UNSUPPORTED_PLATFORM.contains("unsupported"));
        assert!(UNSUPPORTED_PLATFORM.contains("windows"));
    }
}
