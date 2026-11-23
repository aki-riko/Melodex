//! 透明桌面歌词窗。
//!
//! 窗口几何、位置钳制与可视区回拉都对齐旧 PrismQML 实现
//! （`desktop-prismqml/qml/components/DesktopLyricsWindow.qml:74-104`）：
//!
//! ```text
//! 宽 = min(920, max(640, 屏宽 - 96))
//! 高 = 46 + 主行高(字号 + 20) + 副行高(副行字号 + 14) + 18
//! 默认位置 = 水平居中、垂直 76%
//! 任何位置都夹进可视区（clampToVisibleArea）
//! ```
//!
//! 高度**必须随字号变化**：旧实现是 `height` 绑定表达式，改字号窗口跟着长高；
//! 这里把同样的公式放在 Rust 侧，由设置变更时调用 `apply_window_geometry`。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::logging;

pub const OVERLAY_WINDOW: &str = "overlay";

// ---------- 窗口几何（与旧 QML 逐项对齐）----------
//
// 旧实现 DesktopLyricsWindow.qml:74-75 的 width/height 绑定表达式。
// 这里写成常量 + 纯函数，便于单测直接比对数值。

/// 歌词窗最大宽度（旧版 `Math.min(920, ...)`）。
pub const OVERLAY_MAX_WIDTH: f64 = 920.0;
/// 歌词窗最小宽度。
///
/// 旧版是 640（因为它固定不随内容变化）；现在宽度要贴合歌词文字，
/// 短句（"嗯"）只需约 230px，所以下限必须放开，否则窗口永远缩不下来。
/// 但**不能无限窄**：悬停控制条自身就要 212px 宽，再留一点余量，
/// 取 240 作为物理下限（控制条放不下会溢出窗口，看起来像被切掉）。
pub const OVERLAY_MIN_WIDTH: f64 = 240.0;
/// 宽度相对屏幕可用宽度的留白（旧版 `Screen.width - 96`）。
pub const OVERLAY_WIDTH_MARGIN: f64 = 96.0;

/// 贴合内容时的宽度迟滞阈值（px）。
///
/// 每换一行都改窗口尺寸会明显抖动（尤其逐字歌词每行宽度不同）。
/// 只有目标宽度与当前宽度差超过这个值才真正调整——
/// 小于阈值的差异肉眼几乎看不出，不值得为它重建窗口。
pub const CONTENT_WIDTH_HYSTERESIS: f64 = 24.0;

/// 窗口高度中与字号无关的固定部分：顶部留白 46 + 底部留白 18。
///
/// 旧版：`height: 46 + activeLineHeight + secondaryLineHeight + 18`
pub const OVERLAY_HEIGHT_CHROME: f64 = 46.0 + 18.0;
/// 主行行高 = 字号 + 20（旧版 `activeLineHeight`）。
pub const ACTIVE_LINE_EXTRA: f64 = 20.0;
/// 副行行高 = 副行字号 + 14（旧版 `secondaryLineHeight`）。
pub const SECONDARY_LINE_EXTRA: f64 = 14.0;
/// 副行字号 = 主行 × 0.67，最小 16（旧版 `Math.max(16, round(fontSize*0.67))`）。
pub const SECONDARY_SCALE: f64 = 0.67;
pub const SECONDARY_MIN_SIZE: f64 = 16.0;

/// 副行字号，与旧版 `secondaryFontSize` 同式。
pub fn secondary_font_size(font_size: u32) -> f64 {
    (font_size as f64 * SECONDARY_SCALE)
        .round()
        .max(SECONDARY_MIN_SIZE)
}

/// 窗口高度，与旧版 `height` 绑定表达式同式。
pub fn overlay_height(font_size: u32) -> f64 {
    let active_line_height = font_size as f64 + ACTIVE_LINE_EXTRA;
    let secondary_line_height = secondary_font_size(font_size) + SECONDARY_LINE_EXTRA;
    OVERLAY_HEIGHT_CHROME + active_line_height + secondary_line_height
}

/// 窗口宽度，与旧版 `width` 绑定表达式同式。
///
/// 旧版：`Math.min(920, Math.max(640, screenWidth - 96))`
/// 两侧都夹，所以屏幕比 640 还窄时取 640（不做进一步压缩）。
pub fn overlay_width(screen_width: f64) -> f64 {
    (screen_width - OVERLAY_WIDTH_MARGIN).clamp(OVERLAY_MIN_WIDTH, OVERLAY_MAX_WIDTH)
}

/// 把「内容想要多宽」夹成合法窗口宽度。
///
/// 上界同时受屏幕与旧版上限约束；下界是控制条能放下的最小宽度。
/// 这样短句窗口自动缩短、长句最多到 920（与旧版上限一致）。
pub fn clamp_content_width(content_width: f64, screen_width: f64) -> f64 {
    let ceiling = overlay_width(screen_width);
    content_width.clamp(OVERLAY_MIN_WIDTH.min(ceiling), ceiling)
}

/// 目标窗口宽度：`content_width <= 0` 走**固定宽度**，否则按内容贴合。
///
/// ★ 现在前端固定传 0（详见 `apply_content_width` 的注释：宽度随内容变会让
/// 歌词在屏幕上横移）。保留内容分支是为了以后需要时能切回去。
pub fn fixed_or_content_width(content_width: f64, screen_width: f64) -> f64 {
    if content_width <= 0.0 {
        overlay_width(screen_width)
    } else {
        clamp_content_width(content_width, screen_width)
    }
}

/// 把一个坐标夹进 `[minimum, minimum + span]`，与旧版 `clampToVisibleArea` 同式。
///
/// 旧实现用 `Math.max(0, ...)` 处理「窗口比可视区还大」的情形，
/// 即此时允许停在起始边而不是产生负的可用范围。
pub fn clamp_axis(value: i32, minimum: i32, available_span: i32) -> i32 {
    let maximum = minimum + available_span.max(0);
    value.clamp(minimum, maximum)
}

/// 是否已有可显示的歌词状态。
///
/// 用来判断「设置里打开歌词」时该不该立刻显示窗口：没有歌曲在放就没有歌词，
/// 此时显示只会闪一个空窗。由 `lyrics_push_state` 更新。
static HAS_LYRICS_STATE: AtomicBool = AtomicBool::new(false);

pub fn set_has_lyrics_state(has: bool) {
    HAS_LYRICS_STATE.store(has, Ordering::SeqCst);
}

pub fn has_lyrics_state(_app: &AppHandle) -> bool {
    HAS_LYRICS_STATE.load(Ordering::SeqCst)
}

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
///
/// 尺寸走 `overlay_width` / `overlay_height`，与旧 QML 的绑定表达式同式；
/// 初值用默认字号，真实字号在 `setup` 里由设置覆盖（见 `apply_window_geometry`）。
pub fn create_overlay_window(app: &AppHandle, font_size: u32) -> tauri::Result<()> {
    let screen_width = primary_screen_size(app)
        .map(|(width, _height)| width)
        .unwrap_or(OVERLAY_MAX_WIDTH + OVERLAY_WIDTH_MARGIN);
    WebviewWindowBuilder::new(app, OVERLAY_WINDOW, WebviewUrl::App("overlay.html".into()))
        .title("Melodex 桌面歌词")
        .inner_size(overlay_width(screen_width), overlay_height(font_size))
        // 最小尺寸取「最小字号算出来的高度」：与旧版一致，窗口高度由字号推导，
        // 用户不该能把它拖成比最矮字号还小的框（那会把副行切掉）。
        // 注意这里只做下限，不限制上限——大字号时高度由 apply_window_geometry 给足。
        .min_inner_size(
            OVERLAY_MIN_WIDTH,
            overlay_height(crate::lyrics_settings::FONT_SIZE_MINIMUM),
        )
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

/// 主显示器的尺寸（物理像素）。取不到返回 `None`，由调用方用保守默认值。
fn primary_screen_size(app: &AppHandle) -> Option<(f64, f64)> {
    let window = app.get_webview_window(OVERLAY_WINDOW)?;
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())?;
    let size = monitor.size();
    Some((size.width as f64, size.height as f64))
}

/// 把歌词窗的尺寸调整到当前字号对应的值。
///
/// 调用时机：启动时、字号变化时。旧实现是 QML 绑定表达式自动重算，
/// Web 侧没有这层绑定，所以必须显式调用——否则改大字号后窗口高度不够，
/// 副行会被窗口底边切掉（旧版不存在这个问题）。
pub fn apply_window_geometry(app: &AppHandle, font_size: u32) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    let screen_width = primary_screen_size(app)
        .map(|(width, _height)| width)
        // 取不到屏幕时保持现有宽度：不能因为拿不到显示器就把窗口缩到 640。
        .unwrap_or_else(|| {
            window
                .outer_size()
                .map(|size| size.width as f64)
                .unwrap_or(OVERLAY_MAX_WIDTH)
        });
    window
        .set_size(tauri::LogicalSize::new(
            overlay_width(screen_width),
            overlay_height(font_size),
        ))
        .map_err(|error| format!("设置歌词窗口尺寸失败：{error}"))
}

/// 调整歌词窗尺寸。
///
/// ## 两种模式
///
/// - `content_width > 0`：按**内容**宽度贴合（旧行为）。
/// - `content_width <= 0`：宽度按**屏幕**重算（`overlay_width`，与旧版
///   `min(920, max(640, 屏宽-96))` 同式），只有高度随字号变。
///
/// ## 为什么现在默认走「按屏幕固定宽度」
///
/// 用户实测：「歌词一直在往右移动，得固定中心点往两边扩散」。
/// 根因是宽度跟着每行文字算 —— CDP 实测连续三行：
///   「眉目缱绻中 飘零」窗口 360 → 文字中心 x=180
///   「心之 所寄」      窗口 252 → 文字中心 x=126
///   「劫数应声而起」    窗口 312 → 文字中心 x=156
/// 文字中心**始终等于窗口中心**，但窗口宽度变了，于是整块歌词在屏幕上
/// 左右横移了 54px。窗口是独立原生窗口、位置由壳侧固定，
/// 只有宽度固定，文字才能真正钉在屏幕同一处。
///
/// 代价：透明区域会拦截鼠标。缓解办法是默认锁定/穿透（旧版就是这个行为），
/// 需要操作时再解锁。
///
/// @param content_width 内容需要的总宽度；`<= 0` 表示"按屏幕重算"
/// @param font_size     当前字号，用来重算高度（**不能用窗口当前高度**）
/// @returns 是否真的调整过（受迟滞阈值控制）
pub fn apply_content_width(
    app: &AppHandle,
    content_width: f64,
    font_size: u32,
) -> Result<bool, String> {
    if !content_width.is_finite() {
        return Ok(false);
    }
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    let screen_width = primary_screen_size(app)
        .map(|(width, _height)| width)
        .unwrap_or(OVERLAY_MAX_WIDTH + OVERLAY_WIDTH_MARGIN);

    // content_width <= 0 → 按屏幕固定宽度；否则按内容贴合。
    let target_width = fixed_or_content_width(content_width, screen_width);

    // ★ 高度必须按字号重新算，绝不能沿用窗口当前高度。
    //
    // 踩过的坑：一开始写成「取 inner_size().height 原样传回去」，
    // 结果窗口高度从 158 涨到 356 并卡住——
    // 因为高度里含 --active-line-height（按**基准字号**算），
    // 而窄窗口下字号被 fit 缩小、行高按基数却不变，
    // 加上几次调整叠加，高度只增不减，形成正反馈。
    // 高度是字号的一元函数，任何时候都重算即可。
    let target_height = overlay_height(font_size);

    let current = window
        .inner_size()
        .map_err(|error| format!("读取歌词窗口尺寸失败：{error}"))?;
    let width_changed = (target_width - current.width as f64).abs() >= CONTENT_WIDTH_HYSTERESIS;
    let height_changed = (target_height - current.height as f64).abs() >= 1.0;
    if !width_changed && !height_changed {
        return Ok(false);
    }

    window
        .set_size(tauri::LogicalSize::new(target_width, target_height))
        .map_err(|error| format!("调整歌词窗口尺寸失败：{error}"))?;
    // 变宽后右侧可能越界，拉回可视区（与旧版 onHeightChanged 的 clamp 同理）。
    if let Err(error) = clamp_to_visible_area(app) {
        logging::warn(format!("尺寸调整后回拉位置失败：{error}"));
    }
    Ok(true)
}

/// 把歌词窗拉回可视区，与旧版 `clampToVisibleArea` 等价。
///
/// 旧实现的两个触发点这里都要有：
/// ① 恢复位置后（`restorePosition` 里 `Qt.callLater`）；
/// ② **高度变化后**（`onHeightChanged` 里 `Qt.callLater`）——
///    改字号让窗口变高后，原本贴底的位置会跑到屏幕外，旧版会自动拉回来。
pub fn clamp_to_visible_area(app: &AppHandle) -> Result<(i32, i32), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or_else(|| "取不到显示器信息".to_string())?;
    let area = monitor.work_area();
    let size = window
        .outer_size()
        .map_err(|error| format!("读取窗口尺寸失败：{error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("读取窗口位置失败：{error}"))?;

    let x = clamp_axis(
        position.x,
        area.position.x,
        area.size.width as i32 - size.width as i32,
    );
    let y = clamp_axis(
        position.y,
        area.position.y,
        area.size.height as i32 - size.height as i32,
    );
    if x != position.x || y != position.y {
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|error| format!("修正歌词窗口位置失败：{error}"))?;
    }
    Ok((x, y))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secondary_font_size_matches_legacy_formula() {
        // 旧版：Math.max(16, Math.round(fontSize * 0.67))
        assert_eq!(secondary_font_size(36), 24.0);
        assert_eq!(secondary_font_size(64), 43.0);
        // 20 * 0.67 = 13.4 → 13，被下限提到 16
        assert_eq!(secondary_font_size(20), 16.0);
        assert_eq!(secondary_font_size(30), 20.0);
    }

    #[test]
    fn overlay_height_matches_legacy_formula() {
        // 旧版：46 + (字号+20) + (副行字号+14) + 18
        // 字号 36 → 副行 24 → 46 + 56 + 38 + 18 = 158
        assert_eq!(overlay_height(36), 158.0);
        // 字号 64 → 副行 43 → 46 + 84 + 57 + 18 = 205
        assert_eq!(overlay_height(64), 205.0);
        // 字号 20 → 副行 16 → 46 + 40 + 30 + 18 = 134
        assert_eq!(overlay_height(20), 134.0);
    }

    #[test]
    fn overlay_width_matches_legacy_formula() {
        // 旧版：Math.min(920, Math.max(640, screenWidth - 96))
        // 新版把下限从 640 放宽到 240（要让窗口贴合短歌词），
        // 所以只有「屏幕减留白」大于 240 时才能指望旧公式的数值。
        assert_eq!(overlay_width(1920.0), 920.0);
        assert_eq!(overlay_width(1080.0), 920.0, "984 超过上限，夹到 920");
        assert_eq!(overlay_width(1000.0), 904.0);
        // 屏幕减留白后仍然 ≥ 下限时，取实际值（不夹到下限）
        assert_eq!(overlay_width(700.0), 604.0);
        // 屏幕减留白 < 下限时，才被抬高到 OVERLAY_MIN_WIDTH
        assert_eq!(overlay_width(300.0), OVERLAY_MIN_WIDTH);
    }

    #[test]
    fn fixed_width_mode_ignores_content() {
        // ★ `content_width <= 0` 表示「按屏幕固定宽度」，与歌词内容无关。
        //
        // 用户实测「歌词一直在往右移动」：之前宽度跟着每行文字算，
        // 短句窗口缩、长句窗口撑，而窗口位置由壳侧固定 ——
        // 于是文字中心在屏幕上横移（实测连续三行中心 x = 180 / 126 / 156）。
        // 固定宽度后，文字在窗口内居中就等于钉在屏幕同一处。
        //
        // 这里验证：0 与负数都走固定宽度分支，结果等于 overlay_width(屏宽)，
        // 且与"内容宽度"完全无关。
        for content in [0.0, -1.0, -9999.0] {
            // 1920 屏 → overlay_width = min(920, max(240, 1920-96)) = 920
            assert_eq!(
                fixed_or_content_width(content, 1920.0),
                overlay_width(1920.0),
                "content={content} 应走固定宽度分支"
            );
            // 1000 屏 → min(920, max(240, 904)) = 904
            assert_eq!(
                fixed_or_content_width(content, 1000.0),
                overlay_width(1000.0),
                "content={content} 应走固定宽度分支（小屏）"
            );
        }

        // 正数仍按内容贴合（保留旧路径，便于以后需要时切回）
        assert_eq!(fixed_or_content_width(500.0, 1920.0), 500.0);
        assert_eq!(fixed_or_content_width(200.0, 1920.0), 240.0);
    }

    #[test]
    fn clamp_content_width_respects_bounds() {
        // 短句：内容只要 200px，但不能低于控制条能放下的下限 240
        assert_eq!(clamp_content_width(200.0, 1920.0), 240.0);
        // 中等：直接贴合
        assert_eq!(clamp_content_width(500.0, 1920.0), 500.0);
        // 超长：夹到旧版上限 920
        assert_eq!(clamp_content_width(1500.0, 1920.0), 920.0);
        // 小屏幕：上限跟着屏幕走（屏 1000 → 上限 904）
        assert_eq!(clamp_content_width(2000.0, 1000.0), 904.0);
        // 屏幕比下限还窄的极端情况：取屏幕能给的宽度，不反过来撑破
        assert_eq!(clamp_content_width(2000.0, 300.0), 240.0);
    }

    #[test]
    fn min_width_leaves_room_for_control_bar() {
        // 控制条自身 212px（旧版固定值）+ 左右留白，窗口下限必须容得下它，
        // 否则悬停时控制条会溢出窗口被切掉。
        //
        // 用 clamp_content_width 的返回值做判据（而不是两个常量直接比）：
        // 既能验证真实调用路径，也避免 clippy 把 `assert!(常量 >= 常量)` 判为无意义。
        const CONTROL_BAR_WIDTH: f64 = 212.0;
        // 不管内容多窄，夹出来的窗口宽度都必须容得下控制条。
        let narrowest = clamp_content_width(1.0, 1920.0);
        assert!(
            narrowest >= CONTROL_BAR_WIDTH,
            "最窄窗口 {narrowest} 小于控制条 {CONTROL_BAR_WIDTH}，悬停时控制条会被切掉"
        );
    }

    #[test]
    fn height_is_pure_function_of_font_size() {
        // 回归：窗口高度必须只由字号决定，**不允许**沿用窗口当前高度。
        // 曾经写成「取 inner_size().height 原样传回」，结果高度从 158 涨到 356：
        // 窄窗口下字号被 fit 缩小、行高按基准字号却不变，反复调整只增不减。
        //
        // 判据：高度 = 固定余量 + (字号+20) + (副行字号+14)，逐项核一遍，
        // 而不是「自己等于自己」那种恒真断言（clippy 会直接判为无意义）。
        for size in [20u32, 24, 32, 36, 48, 64] {
            let expected = OVERLAY_HEIGHT_CHROME
                + (size as f64 + ACTIVE_LINE_EXTRA)
                + (secondary_font_size(size) + SECONDARY_LINE_EXTRA);
            assert_eq!(
                overlay_height(size),
                expected,
                "字号 {size} 的高度必须严格按公式推导"
            );
        }
        // 单调性 + 合理性：遍历所有字号，确认高度随字号递增且量级正常。
        // 注意不能写成对单个字面量的断言（clippy 会判 `assert!(const < const)` 无意义）；
        // 用折叠/循环让结论依赖函数返回值。
        let sizes = [20u32, 24, 32, 36, 48, 64];
        let heights: Vec<f64> = sizes.iter().map(|size| overlay_height(*size)).collect();
        let ascending = heights.windows(2).all(|pair| pair[1] > pair[0]);
        assert!(ascending, "高度应随字号单调递增：{heights:?}");
        let reasonable = heights.iter().all(|h| *h > 80.0 && *h < 260.0);
        assert!(reasonable, "高度量级异常：{heights:?}");
    }

    #[test]
    fn clamp_axis_matches_legacy_clamp() {
        // 旧版：x = min(minimumX + max(0, available - width), max(minimumX, x))
        assert_eq!(clamp_axis(100, 0, 800), 100, "范围内不动");
        assert_eq!(clamp_axis(-50, 0, 800), 0, "越过左边界拉回");
        assert_eq!(clamp_axis(900, 0, 800), 800, "越过右边界拉回");
        // 多显示器：可视区起点不是 0
        assert_eq!(clamp_axis(1000, 1920, 800), 1920, "第二块屏幕的左边");
        assert_eq!(clamp_axis(5000, 1920, 800), 2720, "第二块屏幕的右边");
        // 窗口比可视区还大：允许贴在起始边（旧版 Math.max(0, ...)）
        assert_eq!(clamp_axis(50, 0, -100), 0);
    }
}
