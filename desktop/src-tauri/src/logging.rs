//! 应用日志：同时写 stderr 与按大小轮转的文件，避免 GUI 模式下证据丢失。
//!
//! 为什么不用 println!/stdout：GUI 进程（windows_subsystem = "windows"）没有控制台，
//! 且被父进程按管道捕获时 stdout 有缓冲，关键证据会迟到或丢失（原型阶段实测踩过）。
//!
//! ★ 为什么是「按大小」而不是「按天」（2026-11 全库扫描核对时修正）：
//!   这个文件的文档头原本写着「按天滚动」，但实现从头到尾只是往单个
//!   `shell.log` 追加 —— 没有任何轮转逻辑。文档与实现不符，而「按天」还
//!   需要把 UTC 时间戳转成本地日历日，标准库不做时区，就得引 chrono；
//!   本项目对依赖版本有严格固定纪律（见 AGENTS.md「依赖版本纪律」），
//!   为一行日志引入一个日期库不划算。
//!
//!   按大小轮转同样解决真问题（文件无限增长），且零新依赖：
//!   超过上限就把当前文件改名为 `shell.log.1`（覆盖旧的 .1），再重开新文件。
//!   只保留一份历史，总量有硬上限 —— 桌面壳是长期驻留进程，这一点是必要的。

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 单个日志文件的大小上限。超过就轮转到 `.1`。
///
/// 5 MB 的依据：桌面壳正常运行时日志量很小（实测运行一段时间后约 47 KB），
/// 5 MB 足以覆盖「开一个会在异常时大量刷日志的坏版本、事后回来取证据」这种
/// 场景；同时两份合计 10 MB，不会让用户觉得占空间。
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// 轮转串行化：两个线程同时发现超限时，只让一个去改名，
/// 避免互相把对方刚创建的文件改成 .1。
static ROTATE_LOCK: Mutex<()> = Mutex::new(());

/// 初始化日志文件路径。必须在任何 `info!` 之前调用。
pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("shell.log");
    let _ = LOG_PATH.set(path);
}

fn log_path() -> Option<&'static PathBuf> {
    LOG_PATH.get()
}

/// 轮转后的历史文件名（`shell.log` → `shell.log.1`）。
fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

/// 若当前文件已达上限，把它改名为 `.1`（覆盖旧的历史）并让调用方重开。
///
/// 只在**写入前**检查：这样写完最后一行才超限的文件会保留完整，
/// 下一次写入时再轮转 —— 不会把一行日志劈成两半。
fn rotate_if_needed(path: &Path) {
    let Ok(meta) = fs::metadata(path) else {
        // 文件还不存在（首次写入）或读不到：交给 OpenOptions 的 create 处理。
        return;
    };
    if meta.len() < MAX_LOG_BYTES {
        return;
    }

    let _guard = ROTATE_LOCK.lock();
    // 拿到锁后重新读一次：可能别的线程已经轮转过了。
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_LOG_BYTES {
        return;
    }

    let rotated = rotated_path(path);
    // rename 会覆盖已存在的 .1（Windows 上 std::fs::rename 允许覆盖文件）。
    // 失败时不做任何事：宁可让文件继续变大，也不能丢日志或 panic。
    let _ = fs::rename(path, rotated);
}

/// 写入一行日志。失败时静默降级到 stderr，绝不 panic：
/// 日志不可用不应该让应用起不来。
pub fn write(level: &str, message: &str) {
    let line = format!("[{level}] {message}\n");
    eprint!("{line}");
    if let Some(path) = log_path() {
        rotate_if_needed(path);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("melodex-logging-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn rotated_path_appends_suffix() {
        let path = PathBuf::from("/logs/shell.log");
        let rotated = rotated_path(&path);
        assert_eq!(rotated, PathBuf::from("/logs/shell.log.1"));
    }

    #[test]
    fn rotate_if_needed_leaves_small_file_alone() {
        let dir = temp_dir("small");
        let path = dir.join("shell.log");
        fs::write(&path, b"hello").expect("写测试文件");

        rotate_if_needed(&path);

        assert!(path.exists(), "未超限时不应轮转");
        assert!(!rotated_path(&path).exists(), "未超限时不应产生 .1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_if_needed_moves_oversized_file_to_dot_one() {
        let dir = temp_dir("big");
        let path = dir.join("shell.log");
        // 不真的写 5MB：临时把阈值当作已知常量，直接造一个超过它的文件。
        // 用稀疏写法仍然要占盘，所以这里造 5MB 的零字节向量 —— 测试里可接受。
        fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).expect("写大文件");

        rotate_if_needed(&path);

        assert!(!path.exists(), "超限后原文件应被移走");
        assert!(rotated_path(&path).exists(), "超限后应产生 .1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_overwrites_existing_history() {
        let dir = temp_dir("overwrite");
        let path = dir.join("shell.log");
        let rotated = rotated_path(&path);
        fs::write(&rotated, b"old-history").expect("写旧历史");
        fs::write(&path, vec![b'y'; (MAX_LOG_BYTES + 1) as usize]).expect("写大文件");

        rotate_if_needed(&path);

        let history = fs::read(&rotated).expect("读历史文件");
        assert_eq!(
            history.len(),
            (MAX_LOG_BYTES + 1) as usize,
            "历史应被新内容覆盖，而不是追加或保留旧的"
        );
        assert!(
            history.iter().all(|b| *b == b'y'),
            "历史内容应来自新的 shell.log"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_is_noop_when_file_missing() {
        let dir = temp_dir("missing");
        let path = dir.join("shell.log");
        // 文件不存在时不能 panic，也不能创建任何东西。
        rotate_if_needed(&path);
        assert!(!path.exists());
        assert!(!rotated_path(&path).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
