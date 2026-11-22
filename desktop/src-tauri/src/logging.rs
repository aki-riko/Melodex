//! 应用日志：同时写 stderr 与按天滚动的文件，避免 GUI 模式下证据丢失。
//!
//! 为什么不用 println!/stdout：GUI 进程（windows_subsystem = "windows"）没有控制台，
//! 且被父进程按管道捕获时 stdout 有缓冲，关键证据会迟到或丢失（原型阶段实测踩过）。

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::OnceLock,
};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 初始化日志文件路径。必须在任何 `info!` 之前调用。
pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("shell.log");
    let _ = LOG_PATH.set(path);
}

fn log_path() -> Option<&'static PathBuf> {
    LOG_PATH.get()
}

/// 写入一行日志。失败时静默降级到 stderr，绝不 panic：
/// 日志不可用不应该让应用起不来。
pub fn write(level: &str, message: &str) {
    let line = format!("[{level}] {message}\n");
    eprint!("{line}");
    if let Some(path) = log_path() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// 供 `log!` 宏族使用。
pub fn info(message: impl std::fmt::Display) {
    write("INFO", &message.to_string());
}

pub fn warn(message: impl std::fmt::Display) {
    write("WARN", &message.to_string());
}

pub fn error(message: impl std::fmt::Display) {
    write("ERROR", &message.to_string());
}
