//! 透明桌面歌词窗。
//!
//! 行为与原 `desktop/src-tauri/src/main.rs` 一致：透明、无边框、置顶、跳过任务栏、
//! 默认鼠标穿透，由托盘切换穿透状态。这里只把窗口创建与穿透控制拆成模块。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::logging;

pub const OVERLAY_WINDOW: &str = "overlay";

pub struct OverlayState {
    click_through: Mutex<bool>,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            click_through: Mutex::new(true),
        }
    }
}

/// 创建歌词窗。默认不可见、不聚焦、鼠标穿透。
pub fn create_overlay_window(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, OVERLAY_WINDOW, WebviewUrl::App("overlay.html".into()))
        .title("Melodex 桌面歌词")
        .inner_size(920.0, 220.0)
        .min_inner_size(560.0, 160.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .accept_first_mouse(true)
        .build()?;
    Ok(())
}

pub fn set_overlay_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    if visible {
        window
            .show()
            .map_err(|error| format!("显示歌词窗口失败：{error}"))
    } else {
        window
            .hide()
            .map_err(|error| format!("隐藏歌词窗口失败：{error}"))
    }
}

pub fn start_overlay_drag(app: &AppHandle) -> Result<(), String> {
    app.get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?
        .start_dragging()
        .map_err(|error| format!("移动歌词窗口失败：{error}"))
}

pub fn get_click_through(state: &OverlayState) -> Result<bool, String> {
    state
        .click_through
        .lock()
        .map(|value| *value)
        .map_err(|_| "读取鼠标穿透状态失败".to_string())
}

/// 应用鼠标穿透并广播给歌词页。
pub fn apply_click_through(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| format!("切换鼠标穿透失败：{error}"))?;
    let state = app.state::<OverlayState>();
    {
        let mut stored = state
            .click_through
            .lock()
            .map_err(|_| "保存鼠标穿透状态失败".to_string())?;
        *stored = enabled;
    }
    window
        .emit("click-through-changed", enabled)
        .map_err(|error| format!("通知鼠标穿透状态失败：{error}"))
}

/// 配对配置变化后通知歌词页重连。
pub fn notify_overlay_config_changed(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW) {
        if let Err(error) = window.emit("desktop-config-changed", ()) {
            logging::warn(format!("notify overlay config change failed: {error}"));
        }
    }
}

pub fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW) {
        let _ = window.hide();
    }
}

/// 读取歌词窗的物理坐标（与 `set_overlay_position` 同单位）。
pub fn overlay_position(app: &AppHandle) -> Result<(i32, i32), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| format!("读取歌词窗口位置失败：{error}"))?;
    Ok((position.x, position.y))
}

/// 设置歌词窗的物理坐标。
///
/// 用 `PhysicalPosition` 而不是逻辑坐标：旧实现存的是屏幕像素，
/// 跨 DPI 变化时物理坐标更接近"用户上次看到的位置"。
pub fn set_overlay_position(app: &AppHandle, x: i32, y: i32) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| format!("设置歌词窗口位置失败：{error}"))
}
