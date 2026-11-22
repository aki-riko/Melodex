//! 桌面歌词设置窗：本地自绘页，调整歌词的显示/锁定/字体/字号/配色/位置。
//!
//! 它与主窗口职责分离：主窗口加载线上站点、不持有任何本地权限；
//! 只有这个本地页（和歌词窗）能调用本地命令。
//!
//! 历史：这个窗口原先承载「设备配对」，2026-11 架构改为壳内直连后配对流程已删除，
//! 窗口改作歌词设置页（与旧 PrismQML 的 SettingsPage「桌面歌词」分组对齐）。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const SETTINGS_WINDOW: &str = "settings";

/// 创建歌词设置窗。`visible=false` 时后台创建，等待用户从托盘打开。
/// 尺寸按「6 行设置 + 说明」留足，太窄会把每行挤成两行。
pub fn create_settings_window(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Melodex 桌面歌词设置")
        .inner_size(640.0, 720.0)
        .min_inner_size(480.0, 560.0)
        .center()
        .visible(visible)
        .resizable(true)
        .build()?;
    Ok(())
}

pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else if let Err(error) = create_settings_window(app, true) {
        crate::logging::error(format!("create settings window failed: {error}"));
    }
}

/// 设置窗关闭时只隐藏，不销毁（与原行为一致）。
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != SETTINGS_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}
