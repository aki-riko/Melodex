//! 暴露给前端的命令。
//!
//! 安全边界：这些命令**只对本地窗口（tauri:// 自绘页面）开放**，
//! 远程站点 origin 不在任何 capability 的 `remote.urls` 里，
//! 因此线上页面无法调用任何本地命令（见 capabilities/）。

use tauri::{AppHandle, State};

use crate::device::{self, DeviceConfig, PublicDeviceConfig};
use crate::overlay::{self, OverlayState};

#[tauri::command]
pub fn public_device_config(app: AppHandle) -> Result<Option<PublicDeviceConfig>, String> {
    device::load_device_config(&app).map(|config| config.as_ref().map(PublicDeviceConfig::from))
}

/// 供歌词页读取完整连接配置（含设备令牌）。
///
/// 仅本地窗口可调用；返回值不写入日志、不回显。
#[tauri::command]
pub fn connection_config(app: AppHandle) -> Result<Option<DeviceConfig>, String> {
    device::load_device_config(&app)
}

#[tauri::command]
pub async fn pair_device(
    app: AppHandle,
    service_url: String,
    code: String,
) -> Result<PublicDeviceConfig, String> {
    let config = device::pair_device(&app, &service_url, &code).await?;
    overlay::notify_overlay_config_changed(&app);
    Ok(config)
}

#[tauri::command]
pub fn clear_pairing(app: AppHandle) -> Result<(), String> {
    device::remove_device_config(&app)?;
    overlay::hide_overlay(&app);
    overlay::notify_overlay_config_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn set_overlay_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    overlay::set_overlay_visible(&app, visible)
}

#[tauri::command]
pub fn start_overlay_drag(app: AppHandle) -> Result<(), String> {
    overlay::start_overlay_drag(&app)
}

#[tauri::command]
pub fn get_click_through(state: State<'_, OverlayState>) -> Result<bool, String> {
    overlay::get_click_through(&state)
}
