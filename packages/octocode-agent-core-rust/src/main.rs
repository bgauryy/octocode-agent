use octocode_agent_core_rust::{
    frame_too_large_response, invalid_response, malformed_request_response, parse_request,
    response_too_large_response, Actor, Response, MAX_PROTOCOL_FRAME_BYTES,
};
use serde_json::Value;
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

const MAX_FRAME_BYTES: usize = MAX_PROTOCOL_FRAME_BYTES;

#[derive(Debug)]
struct FrameTooLarge;

fn db_path() -> Result<PathBuf, ()> {
    let mut args = env::args_os().skip(1);
    match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None) if flag == "--db" => Ok(PathBuf::from(path)),
        _ => Err(()),
    }
}

fn write_response(output: &mut impl Write, response: &Response) -> io::Result<()> {
    let encoded = serde_json::to_vec(response)?;
    let encoded = if encoded.len().saturating_add(1) > MAX_FRAME_BYTES {
        serde_json::to_vec(&response_too_large_response())?
    } else {
        encoded
    };
    output.write_all(&encoded)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>, FrameTooLarge>>> {
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
            if frame.len().saturating_add(payload.len()) > MAX_FRAME_BYTES {
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
        return Ok(Some(Err(FrameTooLarge)));
    }
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
    Ok(Some(Ok(frame)))
}

fn serve(input: &mut impl BufRead, output: &mut impl Write, actor: &mut Actor) -> io::Result<()> {
    loop {
        let response = match read_frame(input)? {
            Some(Ok(frame)) => match std::str::from_utf8(&frame) {
                Ok(line) => match parse_request(line) {
                    Ok(request) => actor.handle(request),
                    Err(error) => invalid_response(Value::Null, error),
                },
                Err(_) => malformed_request_response("Request must be valid UTF-8 JSON"),
            },
            Some(Err(_)) => frame_too_large_response(),
            None => return Ok(()),
        };
        write_response(output, &response)?;
    }
}

fn main() {
    let path = match db_path() {
        Ok(path) => path,
        Err(()) => {
            eprintln!("usage: octocode-agent-core-rust --db <path>");
            std::process::exit(2);
        }
    };
    let mut actor = match Actor::open(path) {
        Ok(actor) => actor,
        Err(_) => {
            eprintln!("unable to open actor database");
            std::process::exit(1);
        }
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut stdout = io::stdout().lock();
    let _ = serve(&mut input, &mut stdout, &mut actor);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::tempdir;

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
        assert!(read_frame(&mut reader).unwrap().unwrap().is_err());
        assert_eq!(read_frame(&mut reader).unwrap().unwrap().unwrap(), b"{}");

        let response = serde_json::to_value(frame_too_large_response()).unwrap();
        assert_eq!(response["schemaVersion"], 1);
        assert_eq!(response["id"], Value::Null);
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "FRAME_TOO_LARGE");

        let mut input = vec![b'x'; MAX_FRAME_BYTES + 1];
        input.extend_from_slice(
            b"\n{\"schemaVersion\":1,\"id\":\"health\",\"method\":\"health\",\"params\":{}}\n",
        );
        let mut input = Cursor::new(input);
        let mut output = Vec::new();
        let root = tempdir().unwrap();
        let mut actor = Actor::open(root.path().join("actor.sqlite3")).unwrap();
        serve(&mut input, &mut output, &mut actor).unwrap();
        let responses = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["error"]["code"], "FRAME_TOO_LARGE");
        assert_eq!(responses[1]["id"], "health");
        assert_eq!(responses[1]["ok"], true);
        assert_eq!(responses[1]["result"]["status"], "ok");
    }

    #[test]
    fn oversized_responses_are_replaced_by_a_bounded_protocol_error() {
        let response = Response::Ok {
            schema_version: 1,
            id: Value::String("request".into()),
            ok: true,
            result: serde_json::json!({"payload":"x".repeat(MAX_FRAME_BYTES)}),
        };
        let mut output = Vec::new();
        write_response(&mut output, &response).unwrap();

        assert!(output.len() <= MAX_FRAME_BYTES);
        let value: Value = serde_json::from_slice(&output[..output.len() - 1]).unwrap();
        assert_eq!(value["id"], Value::Null);
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "FRAME_TOO_LARGE");
    }
}
