//! Runs the embedded harness runtime next to the plugin host.
//!
//! The runtime archive (portable Node.js, the official `@deepseek-ai/dsh`
//! release and `launcher.mjs`) is unpacked once per archive checksum under the
//! plugin's data directory, then `node launcher.mjs` is started. The launcher
//! answers with one JSON status line on stdout and exits when its stdin
//! closes, so dropping the supervisor always stops the harness. The plugin
//! host speaks IPC over its own stdin/stdout: the child never inherits them.

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const PLUGIN_DIR: &str = "deepseek_harness";

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Starting,
    Ready {
        port: u16,
        key: String,
        detail: Value,
    },
    Failed(String),
}

impl Status {
    /// The document the plugin screen polls as `ui/runtime.json`.
    pub fn to_json(&self) -> Value {
        match self {
            Status::Starting => json!({"status": "starting"}),
            Status::Ready { port, key, detail } => {
                json!({"status": "ready", "port": port, "key": key, "detail": detail})
            }
            Status::Failed(error) => json!({"status": "error", "error": error}),
        }
    }
}

struct Process {
    child: Child,
    // Held open for the child's lifetime; closing it asks the launcher to stop.
    stdin: ChildStdin,
}

pub struct Supervisor {
    status: Mutex<Status>,
    process: Mutex<Option<Process>>,
}

impl Supervisor {
    /// Start the harness in the background; `create` must return promptly.
    pub fn start(archive: &'static [u8], checksum: &'static str) -> Arc<Self> {
        let supervisor = Arc::new(Self {
            status: Mutex::new(Status::Starting),
            process: Mutex::new(None),
        });
        let worker = Arc::clone(&supervisor);
        thread::spawn(move || {
            if let Err(error) = worker.run(archive, checksum) {
                worker.set_status(Status::Failed(error));
            }
        });
        supervisor
    }

    pub fn status(&self) -> Status {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or(Status::Starting)
    }

    fn set_status(&self, status: Status) {
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    fn run(&self, archive: &[u8], checksum: &str) -> Result<(), String> {
        if archive.is_empty() {
            return Err("this build does not bundle the harness runtime".into());
        }
        let base = plugin_directory()?;
        let runtime = unpack_runtime(&base.join("runtime"), archive, checksum)?;
        let node = runtime
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut child = Command::new(&node)
            .arg(runtime.join("launcher.mjs"))
            .current_dir(&runtime)
            .env("DSH_POM_DATA_DIR", base.join("data"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("start {}: {error}", node.display()))?;
        let stdin = child.stdin.take().ok_or("launcher stdin is not piped")?;
        let stdout = child.stdout.take().ok_or("launcher stdout is not piped")?;
        if let Ok(mut process) = self.process.lock() {
            *process = Some(Process { child, stdin });
        }

        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .map_err(|error| format!("read launcher status: {error}"))?;
        let reply: Value = serde_json::from_str(line.trim())
            .map_err(|_| "the harness launcher exited before it was ready".to_owned())?;
        match reply["status"].as_str() {
            Some("ready") => {
                let port = reply["port"]
                    .as_u64()
                    .and_then(|port| u16::try_from(port).ok())
                    .ok_or("launcher reported no port")?;
                let key = reply["key"].as_str().ok_or("launcher reported no key")?;
                let detail = json!({"models": reply["models"], "warning": reply["warning"]});
                self.set_status(Status::Ready {
                    port,
                    key: key.to_owned(),
                    detail,
                });
            }
            _ => {
                return Err(reply["error"]
                    .as_str()
                    .unwrap_or("the harness launcher failed")
                    .to_owned())
            }
        }
        self.watch();
        Ok(())
    }

    /// Report a harness that stops after it was ready.
    fn watch(&self) {
        loop {
            thread::sleep(Duration::from_secs(1));
            let Ok(mut process) = self.process.lock() else {
                return;
            };
            let Some(running) = process.as_mut() else {
                return;
            };
            if let Ok(Some(exit)) = running.child.try_wait() {
                *process = None;
                drop(process);
                self.set_status(Status::Failed(format!("the harness stopped ({exit})")));
                return;
            }
        }
    }

    pub fn stop(&self) {
        let process = self
            .process
            .lock()
            .ok()
            .and_then(|mut process| process.take());
        if let Some(mut process) = process {
            drop(process.stdin);
            for _ in 0..20 {
                if matches!(process.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

/// `<dir of POM_PLUGIN_DB>/deepseek_harness`, the data home the POM gives this plugin.
fn plugin_directory() -> Result<PathBuf, String> {
    let parent = std::env::var_os("POM_PLUGIN_DB")
        .map(PathBuf::from)
        .and_then(|database| database.parent().map(Path::to_path_buf))
        .filter(|parent| !parent.as_os_str().is_empty());
    let parent = match parent {
        Some(parent) => parent,
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    Ok(parent.join(PLUGIN_DIR))
}

/// Unpack once per archive checksum, atomically, and drop older runtimes.
pub fn unpack_runtime(root: &Path, archive: &[u8], checksum: &str) -> Result<PathBuf, String> {
    let id = &checksum[..checksum.len().min(16)];
    let target = root.join(id);
    if target.join("launcher.mjs").is_file() {
        return Ok(target);
    }
    fs::create_dir_all(root).map_err(|error| format!("{}: {error}", root.display()))?;
    let partial = root.join(format!(".{id}.partial"));
    let _ = fs::remove_dir_all(&partial);
    let mut unpacker = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    unpacker.set_preserve_permissions(true);
    unpacker
        .unpack(&partial)
        .map_err(|error| format!("unpack harness runtime: {error}"))?;
    fs::rename(&partial, &target).map_err(|error| format!("install harness runtime: {error}"))?;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.file_name() != id {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, path, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn runtime_unpacks_once_per_checksum_and_replaces_older_ones() {
        let root = std::env::temp_dir().join(format!("dsh-unpack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = archive_with(&[("launcher.mjs", b"// one")]);
        let path = unpack_runtime(&root, &first, &"a".repeat(64)).unwrap();
        assert_eq!(fs::read(path.join("launcher.mjs")).unwrap(), b"// one");
        assert_eq!(unpack_runtime(&root, &[], &"a".repeat(64)).unwrap(), path);

        let second = archive_with(&[("launcher.mjs", b"// two")]);
        let next = unpack_runtime(&root, &second, &"b".repeat(64)).unwrap();
        assert_eq!(fs::read(next.join("launcher.mjs")).unwrap(), b"// two");
        assert!(!path.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn status_document_matches_what_the_screen_polls() {
        assert_eq!(Status::Starting.to_json(), json!({"status": "starting"}));
        assert_eq!(
            Status::Failed("boom".into()).to_json(),
            json!({"status": "error", "error": "boom"})
        );
        let ready = Status::Ready {
            port: 4100,
            key: "k".into(),
            detail: json!({}),
        };
        assert_eq!(ready.to_json()["port"], 4100);
        assert_eq!(ready.to_json()["key"], "k");
    }
}
