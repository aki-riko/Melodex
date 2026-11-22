//! 配对设置窗：本地自绘页，用于填写站点地址与一次性配对码。
//!
//! 它与主窗口职责分离：主窗口加载线上站点、不持有任何本地权限；
//! 只有这个本地页（和歌词窗）能调用本地命令。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const SETTINGS_WINDOW: &str = "settings";

/// 创建配对设置窗。`visible=false` 时后台创建，等待用户从托盘打开。
pub fn create_settings_window(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Melodex 桌面歌词配对")
        .inner_size(520.0, 660.0)
        .min_inner_size(460.0, 560.0)
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
