//! 桌面歌词的用户设置（显示开关/锁定/字体/字号/配色/位置）。
//!
//! ## 为什么放在 Rust 侧
//!
//! 设置要被**三个窗口**同时使用：歌词窗（渲染）、设置窗（编辑）、托盘（勾选状态）。
//! 窗口之间不共享内存，靠 `localStorage` 只能各写各的、还会因窗口销毁而丢；
//! 所以这里做**唯一真相源**：落一个 JSON 文件，任何窗口改动都经命令回到这里，
//! 再由 Rust 广播给所有窗口。
//!
//! ## 与旧 PrismQML 实现的关系
//!
//! 字段与语义逐条对齐 `desktop-prismqml/melodex_desktop/config.py`：
//! `desktop_lyrics_visible` / `desktop_lyrics_click_through` /
//! `desktop_lyrics_font_preset` / `desktop_lyrics_font_size` /
//! `desktop_lyrics_color_scheme` / `desktop_lyrics_position_set|x|y`。
//! 配色与字体清单同样照抄，**不要自己加值**——用户是按旧版的样子验收的。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::logging;

const SETTINGS_FILE_NAME: &str = "desktop-lyrics-settings.json";
const SETTINGS_DIR_ENV: &str = "MELODEX_DESKTOP_LYRICS_CONFIG_DIR";

/// 设置变化广播给全部窗口的事件名。
///
/// 三个窗口都要跟着变：歌词窗重绘、设置页刷新控件、托盘同步勾选。
pub const SETTINGS_EVENT: &str = "melodex:lyrics-settings";

/// 字号范围，与 `config.py` 的 LYRICS_FONT_SIZE_MINIMUM/MAXIMUM 一致。
pub const FONT_SIZE_MINIMUM: u32 = 20;
pub const FONT_SIZE_MAXIMUM: u32 = 64;
pub const DEFAULT_FONT_SIZE: u32 = 36;

/// 已播放色，未播放色统一 `#EEEEEE`（与 config.py 的 8 套配色逐字一致）。
pub const COLOR_SCHEMES: [(&str, &str); 8] = [
    ("珊瑚绯", "#FFC6C6"),
    ("暮霞", "#EEC1D1"),
    ("樱雾", "#FDD6EB"),
    ("晴澜", "#C7E4F1"),
    ("青芽", "#E6FAD0"),
    ("藤影", "#E7E3FB"),
    ("杏月", "#FCE8C2"),
    ("雾银", "#D3D2D2"),
];

pub const DEFAULT_COLOR_SCHEME: &str = "珊瑚绯";

/// 未播放歌词颜色，8 套配色共用。
pub const UNPLAYED_COLOR: &str = "#EEEEEE";

/// 6 种字体预设，与 `WINDOWS_LYRICS_FONT_PRESETS` 一致。
pub const FONT_PRESETS: [(&str, &str); 6] = [
    ("楷体", "KaiTi"),
    ("微软雅黑", "Microsoft YaHei UI"),
    ("等线", "DengXian"),
    ("宋体", "SimSun"),
    ("黑体", "SimHei"),
    ("仿宋", "FangSong"),
];

pub const DEFAULT_FONT_PRESET: &str = "微软雅黑";

/// 用户设置。所有字段都有默认值，配置文件缺字段或损坏时逐项回退。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LyricsSettings {
    /// 显示桌面歌词（关闭后不再自动弹出，可从托盘或设置页重新打开）。
    pub visible: bool,
    /// 锁定 = 鼠标穿透（与旧实现的 clickThrough 同义）。
    pub click_through: bool,
    /// 字体预设名（`FONT_PRESETS` 的键，不是 family）。
    pub font_preset: String,
    /// 主行字号，20..64。
    pub font_size: u32,
    /// 配色方案名（`COLOR_SCHEMES` 的键）。
    pub color_scheme: String,
    /// 是否保存过位置。false 表示用默认位置（水平居中、垂直 76%）。
    pub position_set: bool,
    pub position_x: i32,
    pub position_y: i32,
}

impl Default for LyricsSettings {
    fn default() -> Self {
        Self {
            // 默认显示，与旧实现 `desktop_lyrics_visible` 默认 true 一致。
            visible: true,
            // 默认穿透，与旧实现 `_click_through = True` 及现有壳行为一致。
            click_through: true,
            font_preset: DEFAULT_FONT_PRESET.to_string(),
            font_size: DEFAULT_FONT_SIZE,
            color_scheme: DEFAULT_COLOR_SCHEME.to_string(),
            position_set: false,
            position_x: 0,
            position_y: 0,
        }
    }
}

impl LyricsSettings {
    /// 把外部传入的值夹到合法范围。任何非法输入都回退到默认，不报错。
    ///
    /// 这样即使配置文件被手改成 `font_size: 9999` 或未知配色名，
    /// 歌词窗也只会安静地用默认值渲染，而不是白屏或崩溃。
    pub fn sanitized(mut self) -> Self {
        if !FONT_PRESETS
            .iter()
            .any(|(name, _)| *name == self.font_preset)
        {
            self.font_preset = DEFAULT_FONT_PRESET.to_string();
        }
        if !COLOR_SCHEMES
            .iter()
            .any(|(name, _)| *name == self.color_scheme)
        {
            self.color_scheme = DEFAULT_COLOR_SCHEME.to_string();
        }
        self.font_size = self.font_size.clamp(FONT_SIZE_MINIMUM, FONT_SIZE_MAXIMUM);
        self
    }

    /// 当前配色方案对应的已播放颜色。
    pub fn played_color(&self) -> &'static str {
        COLOR_SCHEMES
            .iter()
            .find(|(name, _)| *name == self.color_scheme)
            .map(|(_, color)| *color)
            .unwrap_or(COLOR_SCHEMES[0].1)
    }

    /// 当前字体预设对应的 CSS font-family 名。
    pub fn font_family(&self) -> &'static str {
        FONT_PRESETS
            .iter()
            .find(|(name, _)| *name == self.font_preset)
            .map(|(_, family)| *family)
            .unwrap_or(FONT_PRESETS[1].1)
    }
}

/// 发给前端的快照：在设置之外带上前端直接可用的色值与字体名，
/// 免得 JS 里再抄一份清单（抄两份必然分叉）。
#[derive(Debug, Clone, Serialize)]
pub struct LyricsSettingsView {
    #[serde(flatten)]
    pub settings: LyricsSettings,
    pub played_color: &'static str,
    pub unplayed_color: &'static str,
    pub font_family: &'static str,
    /// 可选项清单，供设置页渲染下拉框。
    pub color_schemes: Vec<ColorSchemeItem>,
    pub font_presets: Vec<FontPresetItem>,
    pub font_size_min: u32,
    pub font_size_max: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColorSchemeItem {
    pub name: &'static str,
    pub color: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct FontPresetItem {
    pub name: &'static str,
    pub family: &'static str,
}

impl From<LyricsSettings> for LyricsSettingsView {
    fn from(settings: LyricsSettings) -> Self {
        Self {
            played_color: settings.played_color(),
            unplayed_color: UNPLAYED_COLOR,
            font_family: settings.font_family(),
            color_schemes: COLOR_SCHEMES
                .iter()
                .map(|(name, color)| ColorSchemeItem { name, color })
                .collect(),
            font_presets: FONT_PRESETS
                .iter()
                .map(|(name, family)| FontPresetItem { name, family })
                .collect(),
            font_size_min: FONT_SIZE_MINIMUM,
            font_size_max: FONT_SIZE_MAXIMUM,
            settings,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os(SETTINGS_DIR_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(directory).join(SETTINGS_FILE_NAME));
    }
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE_NAME))
        .map_err(|error| format!("读取应用配置目录失败：{error}"))
}

/// 读取设置。文件不存在或损坏都回退到默认值，**不阻断启动**。
pub fn load(app: &AppHandle) -> LyricsSettings {
    let path = match settings_path(app) {
        Ok(path) => path,
        Err(error) => {
            crate::logging::warn(format!("读取歌词设置路径失败，使用默认值：{error}"));
            return LyricsSettings::default();
        }
    };
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LyricsSettings::default()
        }
        Err(error) => {
            crate::logging::warn(format!("读取歌词设置失败，使用默认值：{error}"));
            return LyricsSettings::default();
        }
    };
    match serde_json::from_slice::<LyricsSettings>(&bytes) {
        Ok(settings) => settings.sanitized(),
        Err(error) => {
            crate::logging::warn(format!("歌词设置已损坏，使用默认值：{error}"));
            LyricsSettings::default()
        }
    }
}

/// 保存设置。写失败只记日志并返回错误，由调用方决定是否回滚 UI。
pub fn save(app: &AppHandle, settings: &LyricsSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "歌词设置目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建歌词设置目录失败：{error}"))?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("序列化歌词设置失败：{error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("写入歌词设置失败：{error}"))
}

// ---------- 运行时状态 ----------

/// 进程内缓存。与配置文件保持同步：每次改动先写盘成功再更新缓存，
/// 避免出现「UI 显示已改、重启后又变回去」的割裂。
pub struct LyricsSettingsState {
    inner: Mutex<LyricsSettings>,
}

impl LyricsSettingsState {
    pub fn new(settings: LyricsSettings) -> Self {
        Self {
            inner: Mutex::new(settings),
        }
    }

    pub fn snapshot(&self) -> LyricsSettings {
        self.inner
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    fn replace(&self, settings: LyricsSettings) -> LyricsSettings {
        match self.inner.lock() {
            Ok(mut guard) => {
                *guard = settings.clone();
                settings
            }
            Err(_) => {
                logging::error("歌词设置状态锁已中毒，本次改动未缓存");
                settings
            }
        }
    }
}

/// 只覆盖传入的字段，其余保持原值。
///
/// 用「补丁」而不是整份提交：设置页一次只改一项，整份提交会让并发改动互相覆盖；
/// 而且以后新增字段时旧调用点不会把新字段悄悄重置成默认值。
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct LyricsSettingsPatch {
    pub visible: Option<bool>,
    pub click_through: Option<bool>,
    pub font_preset: Option<String>,
    pub font_size: Option<u32>,
    pub color_scheme: Option<String>,
    pub position_set: Option<bool>,
    pub position_x: Option<i32>,
    pub position_y: Option<i32>,
}

impl LyricsSettingsPatch {
    pub fn apply_to(&self, mut settings: LyricsSettings) -> LyricsSettings {
        if let Some(value) = self.visible {
            settings.visible = value;
        }
        if let Some(value) = self.click_through {
            settings.click_through = value;
        }
        if let Some(value) = &self.font_preset {
            settings.font_preset = value.clone();
        }
        if let Some(value) = self.font_size {
            settings.font_size = value;
        }
        if let Some(value) = &self.color_scheme {
            settings.color_scheme = value.clone();
        }
        if let Some(value) = self.position_set {
            settings.position_set = value;
        }
        if let Some(value) = self.position_x {
            settings.position_x = value;
        }
        if let Some(value) = self.position_y {
            settings.position_y = value;
        }
        // 夹取放在最后统一做：补丁里的非法值不会流到任何窗口。
        settings.sanitized()
    }
}

/// 把设置广播给所有窗口。
pub fn broadcast(app: &AppHandle, settings: &LyricsSettings) {
    let view = LyricsSettingsView::from(settings.clone());
    if let Err(error) = app.emit(SETTINGS_EVENT, &view) {
        logging::warn(format!("广播歌词设置失败：{error}"));
    }
}

/// 应用一次补丁：写盘 → 更新缓存 → 广播 → 同步托盘勾选与窗口可见性。
///
/// 写盘失败时**不改缓存也不广播**，让 UI 保持旧值并被调用方告知失败，
/// 避免「界面显示改了、实际没保存」的假成功。
pub fn apply_patch(
    app: &AppHandle,
    state: &LyricsSettingsState,
    patch: &LyricsSettingsPatch,
) -> Result<LyricsSettings, String> {
    let current = state.snapshot();
    let updated = patch.apply_to(current);
    save(app, &updated)?;
    let updated = state.replace(updated);
    broadcast(app, &updated);
    crate::tray::sync_check_items(app, &updated);
    Ok(updated)
}

/// 默认位置：水平居中、垂直 76%（与旧实现 `defaultX`/`defaultY` 一致）。
///
/// 返回物理像素。主显示器取不到时回退 `None`，由调用方保持原位。
pub fn default_position(app: &AppHandle) -> Option<(i32, i32)> {
    let window = app.get_webview_window(crate::overlay::OVERLAY_WINDOW)?;
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let size = window.outer_size().ok()?;
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + (area.size.height as f64 * 0.76) as i32;
    Some((x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_legacy_implementation() {
        let settings = LyricsSettings::default();
        assert!(settings.visible, "旧实现 desktop_lyrics_visible 默认 true");
        assert!(settings.click_through, "旧实现 _click_through 默认 true");
        assert_eq!(settings.font_size, 36);
        assert_eq!(settings.color_scheme, "珊瑚绯");
        assert_eq!(settings.font_preset, "微软雅黑");
        assert!(!settings.position_set, "未拖动过就不该有保存位置");
    }

    #[test]
    fn color_schemes_match_legacy_config() {
        // 逐条比对 config.py 的 LYRICS_COLOR_SCHEMES。
        assert_eq!(COLOR_SCHEMES.len(), 8);
        assert_eq!(COLOR_SCHEMES[0], ("珊瑚绯", "#FFC6C6"));
        assert_eq!(COLOR_SCHEMES[1], ("暮霞", "#EEC1D1"));
        assert_eq!(COLOR_SCHEMES[2], ("樱雾", "#FDD6EB"));
        assert_eq!(COLOR_SCHEMES[3], ("晴澜", "#C7E4F1"));
        assert_eq!(COLOR_SCHEMES[4], ("青芽", "#E6FAD0"));
        assert_eq!(COLOR_SCHEMES[5], ("藤影", "#E7E3FB"));
        assert_eq!(COLOR_SCHEMES[6], ("杏月", "#FCE8C2"));
        assert_eq!(COLOR_SCHEMES[7], ("雾银", "#D3D2D2"));
        assert_eq!(UNPLAYED_COLOR, "#EEEEEE");
    }

    #[test]
    fn font_presets_match_legacy_config() {
        assert_eq!(FONT_PRESETS.len(), 6);
        assert_eq!(FONT_PRESETS[0], ("楷体", "KaiTi"));
        assert_eq!(FONT_PRESETS[1], ("微软雅黑", "Microsoft YaHei UI"));
        assert_eq!(FONT_PRESETS[2], ("等线", "DengXian"));
        assert_eq!(FONT_PRESETS[3], ("宋体", "SimSun"));
        assert_eq!(FONT_PRESETS[4], ("黑体", "SimHei"));
        assert_eq!(FONT_PRESETS[5], ("仿宋", "FangSong"));
    }

    #[test]
    fn font_size_is_clamped_into_range() {
        let too_large = LyricsSettings {
            font_size: 9999,
            ..Default::default()
        };
        assert_eq!(too_large.sanitized().font_size, FONT_SIZE_MAXIMUM);
        let too_small = LyricsSettings {
            font_size: 1,
            ..Default::default()
        };
        assert_eq!(too_small.sanitized().font_size, FONT_SIZE_MINIMUM);
    }

    #[test]
    fn unknown_scheme_and_preset_fall_back_to_default() {
        let settings = LyricsSettings {
            color_scheme: "不存在的配色".to_string(),
            font_preset: "不存在的字体".to_string(),
            ..Default::default()
        };
        let clean = settings.sanitized();
        assert_eq!(clean.color_scheme, DEFAULT_COLOR_SCHEME);
        assert_eq!(clean.font_preset, DEFAULT_FONT_PRESET);
    }

    #[test]
    fn played_color_and_family_resolve_from_names() {
        let settings = LyricsSettings {
            color_scheme: "晴澜".to_string(),
            font_preset: "宋体".to_string(),
            ..Default::default()
        };
        assert_eq!(settings.played_color(), "#C7E4F1");
        assert_eq!(settings.font_family(), "SimSun");
    }

    #[test]
    fn deserializes_partial_json_with_defaults() {
        // 模拟旧版/手改配置文件：只有个别字段。
        let raw = r#"{"font_size":44,"color_scheme":"雾银"}"#;
        let settings: LyricsSettings = serde_json::from_str(raw).expect("缺字段应能解析");
        let clean = settings.sanitized();
        assert_eq!(clean.font_size, 44);
        assert_eq!(clean.color_scheme, "雾银");
        // 未出现的字段用默认值，而不是 0 / false。
        assert!(clean.visible);
        assert!(clean.click_through);
        assert_eq!(clean.font_preset, DEFAULT_FONT_PRESET);
    }

    #[test]
    fn view_exposes_options_for_settings_page() {
        let view = LyricsSettingsView::from(LyricsSettings::default());
        assert_eq!(view.color_schemes.len(), 8);
        assert_eq!(view.font_presets.len(), 6);
        assert_eq!(view.font_size_min, 20);
        assert_eq!(view.font_size_max, 64);
        assert_eq!(view.played_color, "#FFC6C6");
        assert_eq!(view.unplayed_color, "#EEEEEE");
    }

    #[test]
    fn patch_only_touches_provided_fields() {
        // 只改字号，其它字段必须原样保留——设置页每次只发一项。
        let base = LyricsSettings {
            color_scheme: "藤影".to_string(),
            position_set: true,
            position_x: 100,
            position_y: 200,
            ..Default::default()
        };

        let patch = LyricsSettingsPatch {
            font_size: Some(48),
            ..Default::default()
        };
        let updated = patch.apply_to(base);
        assert_eq!(updated.font_size, 48);
        assert_eq!(updated.color_scheme, "藤影", "未传的配色不该被重置");
        assert!(updated.position_set, "未传的位置标记不该被重置");
        assert_eq!(updated.position_x, 100);
        assert_eq!(updated.position_y, 200);
    }

    #[test]
    fn patch_still_clamps_out_of_range_values() {
        let patch = LyricsSettingsPatch {
            font_size: Some(1000),
            ..Default::default()
        };
        let updated = patch.apply_to(LyricsSettings::default());
        assert_eq!(updated.font_size, FONT_SIZE_MAXIMUM);
    }

    #[test]
    fn patch_rejects_unknown_scheme() {
        let patch = LyricsSettingsPatch {
            color_scheme: Some("朝阳红".to_string()),
            ..Default::default()
        };
        let updated = patch.apply_to(LyricsSettings::default());
        assert_eq!(updated.color_scheme, DEFAULT_COLOR_SCHEME);
    }

    #[test]
    fn empty_patch_changes_nothing() {
        let base = LyricsSettings::default();
        let updated = LyricsSettingsPatch::default().apply_to(base.clone());
        assert_eq!(updated.font_size, base.font_size);
        assert_eq!(updated.color_scheme, base.color_scheme);
        assert_eq!(updated.visible, base.visible);
        assert_eq!(updated.click_through, base.click_through);
    }

    #[test]
    fn patch_can_disable_visibility_and_lock() {
        let patch = LyricsSettingsPatch {
            visible: Some(false),
            click_through: Some(false),
            ..Default::default()
        };
        let updated = patch.apply_to(LyricsSettings::default());
        assert!(!updated.visible, "关闭歌词后不应再自动弹出");
        assert!(!updated.click_through, "解锁后应可拖动");
    }

    #[test]
    fn patch_can_clear_saved_position() {
        let base = LyricsSettings {
            position_set: true,
            position_x: 5,
            ..Default::default()
        };
        let patch = LyricsSettingsPatch {
            position_set: Some(false),
            ..Default::default()
        };
        let updated = patch.apply_to(base);
        assert!(!updated.position_set, "重置位置应清除标记，回到默认位置");
    }
}
