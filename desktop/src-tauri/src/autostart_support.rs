//! 开机自启封装。
//!
//! 用 `--autostart` 参数标记「由系统开机拉起」，主窗口据此静默启动（不抢焦点）。
//! 注意：静默启动**不自动播放**。浏览器/WebView 的自动播放策略依旧生效，
//! 前端只恢复上次播放进度，不发起 play()。

use autostart::{MacosLauncher, ManagerExt as _};
use tauri::AppHandle;

use crate::logging;

/// 开机自启时附加的参数。前端与 Rust 都用它判断启动来源。
pub const AUTOSTART_FLAG: &str = "--autostart";

/// 本次进程是否由开机自启拉起。
pub fn launched_by_autostart() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_FLAG)
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_FLAG]))
}

/// 读取当前开机自启状态。插件未就绪或读取失败时返回 false（菜单按未勾选显示）。
pub fn is_enabled(app: &AppHandle) -> bool {
    match app.autolaunch().is_enabled() {
        Ok(enabled) => enabled,
        Err(error) => {
            logging::warn(format!("read autostart state failed: {error}"));
            false
        }
    }
}

pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|error| format!("切换开机自启失败：{error}"))?;
    logging::info(format!("autostart set to {enabled}"));
    Ok(())
}
