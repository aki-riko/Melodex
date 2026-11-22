//! 暴露给前端的命令。
//!
//! 安全边界（分两档）：
//!
//! **A 档：只有本地窗口（`tauri://` 自绘页面）可调用**
//! 配对、设备令牌、穿透、拖动等。远程站点 origin 不在这些 capability 的
//! `remote.urls` 里，线上页面无法调用。
//!
//! **B 档：主窗口的远程页面也可调用，但只有两条，且语义自限**
//! `lyrics_push_state`（把当前播放状态告诉本机歌词窗）与
//! `lyrics_send_command`（歌词窗按钮转发的播放控制）。
//! 它们由 `app_manifest` 自动生成 `allow-lyrics-*` 权限，
//! 单独挂在 `capabilities/lyrics-bridge.json`，不涉及任何文件/网络/系统能力。

use tauri::{AppHandle, State};

use crate::device::{self, DeviceConfig, PublicDeviceConfig};
use crate::lyrics_bridge::{self, LyricsState};
use crate::lyrics_settings::{self, LyricsSettingsPatch, LyricsSettingsState, LyricsSettingsView};
use crate::overlay::{self, OverlayState};

// ---------- A 档：仅本地窗口 ----------

#[tauri::command]
pub fn public_device_config(app: AppHandle) -> Result<Option<PublicDeviceConfig>, String> {
    device::load_device_config(&app).map(|config| config.as_ref().map(PublicDeviceConfig::from))
}

/// 供歌词页/设置页读取完整连接配置（含设备令牌）。
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

// ---------- 歌词用户设置（本地窗口可读写） ----------

/// 读取歌词设置（含可选项清单与解析后的色值/字体名）。
#[tauri::command]
pub fn lyrics_settings_get(state: State<'_, LyricsSettingsState>) -> LyricsSettingsView {
    LyricsSettingsView::from(state.snapshot())
}

/// 局部更新歌词设置。只改传入的字段。
///
/// 写盘失败会返回错误且**不改变任何窗口状态**，让 UI 能如实回滚。
#[tauri::command]
pub fn lyrics_settings_update(
    app: AppHandle,
    state: State<'_, LyricsSettingsState>,
    patch: LyricsSettingsPatch,
) -> Result<LyricsSettingsView, String> {
    let updated = lyrics_settings::apply_patch(&app, &state, &patch)?;
    // 可见性/穿透属于「立即生效」项，改完要马上作用于窗口，
    // 不能等下一次播放状态推送（推送只带歌词，不带设置）。
    let _ = overlay::set_overlay_visible(&app, updated.visible && overlay::has_lyrics_state(&app));
    if let Err(error) = overlay::apply_click_through(&app, updated.click_through) {
        // 穿透切换失败不应让整次保存失败：设置已经落盘了。
        crate::logging::warn(format!("应用歌词穿透状态失败：{error}"));
    }
    Ok(LyricsSettingsView::from(updated))
}

/// 把歌词窗位置重置为默认（水平居中、垂直 76%）并清除「已保存」标记。
#[tauri::command]
pub fn lyrics_reset_position(
    app: AppHandle,
    state: State<'_, LyricsSettingsState>,
) -> Result<LyricsSettingsView, String> {
    let mut patch = LyricsSettingsPatch {
        position_set: Some(false),
        ..Default::default()
    };
    if let Some((x, y)) = lyrics_settings::default_position(&app) {
        patch.position_x = Some(x);
        patch.position_y = Some(y);
        if let Err(error) = overlay::set_overlay_position(&app, x, y) {
            crate::logging::warn(format!("重置歌词窗位置失败：{error}"));
        }
    }
    let updated = lyrics_settings::apply_patch(&app, &state, &patch)?;
    Ok(LyricsSettingsView::from(updated))
}

/// 歌词窗拖动结束后保存位置（写入设置文件，供设置页显示与重启恢复）。
#[tauri::command]
pub fn lyrics_save_position(
    app: AppHandle,
    state: State<'_, LyricsSettingsState>,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let patch = LyricsSettingsPatch {
        position_set: Some(true),
        position_x: Some(x),
        position_y: Some(y),
        ..Default::default()
    };
    lyrics_settings::apply_patch(&app, &state, &patch).map(|_| ())
}

/// 读取歌词窗当前物理位置，供前端做位置记忆。
#[tauri::command]
pub fn overlay_position(app: AppHandle) -> Result<(i32, i32), String> {
    overlay::overlay_position(&app)
}

/// 恢复歌词窗位置。坐标是**物理像素**，与 `overlay_position` 返回值同单位。
#[tauri::command]
pub fn set_overlay_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    overlay::set_overlay_position(&app, x, y)
}

// ---------- B 档：主窗口远程页面可用（窄权限） ----------

/// 主窗口把当前播放状态推给本机歌词窗。
///
/// 只做转发，不落盘、不联网、不读文件。非法 kind 直接拒绝。
#[tauri::command]
pub fn lyrics_push_state(app: AppHandle, state: LyricsState) -> Result<(), String> {
    if !state.is_known_kind() {
        return Err(format!("不支持的歌词状态类型: {}", state.kind));
    }
    lyrics_bridge::forward_state(&app, &state);
    Ok(())
}

/// 歌词窗把按钮动作转给主窗口页面。
///
/// 命令走白名单，其余一律拒绝。
///
/// `prev`/`toggle`/`next` 转发给主窗口页面（播放控制在那边）；
/// `lock`/`close` 是**歌词窗本地语义**（改本机设置），不经过页面，
/// 由歌词窗直接调 `lyrics_settings_update` 完成——所以这里不接受它们，
/// 避免出现两条改同一状态的路径。
#[tauri::command]
pub fn lyrics_send_command(app: AppHandle, command: String) -> Result<(), String> {
    match command.as_str() {
        "prev" | "toggle" | "next" => {
            lyrics_bridge::forward_command(&app, &command);
            Ok(())
        }
        other => Err(format!("不支持的歌词命令: {other}")),
    }
}
