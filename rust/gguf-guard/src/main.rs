//! CLI twin of the in-process addon: useful for checking a file by hand.
use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let path = match env::args().nth(1) {
        Some(value) => value,
        None => {
            eprintln!("usage: gguf-guard <file>");
            return ExitCode::from(2);
        }
    };
    match gguf_guard::inspect(&path) {
        Ok((version, tensors, kvs)) => {
            println!("{{\"version\":{version},\"tensorCount\":{tensors},\"kvCount\":{kvs}}}");
            ExitCode::SUCCESS
        }
        Err(reason) => {
            eprintln!("{reason}");
            ExitCode::from(2)
        }
    }
}
