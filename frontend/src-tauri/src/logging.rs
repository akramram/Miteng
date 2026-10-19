//! Process-wide logging to stderr and a size-capped file.
//!
//! An app opened from Finder has no terminal, so stderr alone leaves no trace
//! of what happened during a recording. The file lives where the OS keeps app
//! logs (`~/Library/Logs/Miteng` on macOS, `<data root>/logs` elsewhere); when
//! it reaches [`MAX_BYTES`] it is moved to `miteng.1.log` and a new one starts,
//! so at most two files are kept.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;

const MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Directory holding `miteng.log`.
pub fn log_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Logs/Miteng")
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::paths::install_data_root().join("logs")
    }
}

/// Install the global logger. `RUST_LOG` still overrides the `info` default.
pub fn init() {
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    match RotatingFile::open(log_dir().join("miteng.log")) {
        Ok(file) => {
            builder.target(env_logger::Target::Pipe(Box::new(Tee { file })));
        }
        Err(e) => eprintln!("Miteng: file logging disabled: {e}"),
    }
    builder.init();
}

/// Writes every log line to stderr as well as the file.
struct Tee {
    file: RotatingFile,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = io::stderr().write_all(buf);
        // A full disk must not take logging (or the app) down with it.
        let _ = self.file.write_all(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stderr().flush();
        self.file.flush()
    }
}

struct RotatingFile {
    path: PathBuf,
    file: File,
    written: u64,
}

impl RotatingFile {
    fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata()?.len();
        let mut log = Self { path, file, written };
        if log.written >= MAX_BYTES {
            log.rotate()?;
        }
        Ok(log)
    }

    fn rotate(&mut self) -> io::Result<()> {
        fs::rename(&self.path, self.path.with_extension("1.log"))?;
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.written = 0;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written + buf.len() as u64 > MAX_BYTES {
            self.rotate()?;
        }
        let written = self.file.write(buf)?;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_previous_file_when_the_cap_is_reached() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("miteng.log");
        let mut log = RotatingFile::open(path.clone()).unwrap();
        let line = vec![b'a'; 1024 * 1024];
        for _ in 0..(MAX_BYTES / line.len() as u64) {
            log.write_all(&line).unwrap();
        }
        log.write_all(b"after cap\n").unwrap();
        log.flush().unwrap();

        assert_eq!(fs::metadata(dir.path().join("miteng.1.log")).unwrap().len(), MAX_BYTES);
        assert_eq!(fs::read(&path).unwrap(), b"after cap\n");
    }
}
