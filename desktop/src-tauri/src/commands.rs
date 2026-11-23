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
    // ★ 只有「显式改了 visible」时才去动窗口可见性。
    //
    // 踩过的坑（用户实测：点「锁定」后歌词直接没了）：
    // 原实现每次都执行
    //     set_overlay_visible(updated.visible && has_lyrics_state())
    // 而 has_lyrics_state() 表示「最近收到过带歌词的状态推送」，
    // 它只在播放时才有值。于是用户在暂停/未播放时点「锁定」，
    // 这条语句会把窗口**隐藏**——明明只是切穿透，歌词却整个消失，
    // 且设置里 visible 仍是 true，看起来像「设置没生效」。
    //
    // 把「可见性」与「穿透/字体/字号/配色」彻底解耦：
    // 改后四者绝不碰窗口显隐。
    let before = state.snapshot();
    let visibility_changed = patch.visible.is_some() && patch.visible != Some(before.visible);
    let updated = lyrics_settings::apply_patch(&app, &state, &patch)?;

    if visibility_changed {
        let _ =
            overlay::set_overlay_visible(&app, updated.visible && overlay::has_lyrics_state(&app));
    }
    if patch.click_through.is_some() {
        if let Err(error) = overlay::apply_click_through(&app, updated.click_through) {
            // 穿透切换失败不应让整次保存失败：设置已经落盘了。
            crate::logging::warn(format!("应用歌词穿透状态失败：{error}"));
        }
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

/// 把歌词窗夹回可视区，返回修正后的坐标。
///
/// 对应旧实现 `clampToVisibleArea`（DesktopLyricsWindow.qml:97-104）：
/// 旧版在**每次坐标变化**后都会夹一次，所以窗口永远不会被拖到屏幕外。
/// Web 侧拖动由 `start_dragging()` 交给系统处理，拿不到逐帧坐标，
/// 因此在**拖动结束**时调用一次即可达到同样的效果。
#[tauri::command]
pub fn overlay_clamp_position(app: AppHandle) -> Result<(i32, i32), String> {
    overlay::clamp_to_visible_area(&app)
}

/// 按歌词内容调整窗口宽度（让透明窗口不解挡一大片屏幕）。
///
/// `content_width` 由歌词窗用真实排版量出（含左右留白）；
/// `font_size` 用于重算高度 —— 高度是字号的一元函数，**绝不能沿用窗口当前高度**
/// （曾经沿用，导致高度只增不减，窗口从 158 涨到 356 并卡住）。
/// 返回是否真的调整过——受迟滞阈值控制，差异太小不动，避免逐行抖动。
#[tauri::command]
pub fn lyrics_resize_to_content(
    app: AppHandle,
    content_width: f64,
    font_size: u32,
) -> Result<bool, String> {
    overlay::apply_content_width(&app, content_width, font_size)
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
