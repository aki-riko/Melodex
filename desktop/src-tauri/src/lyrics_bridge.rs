//! 桌面歌词壳内直连通道。
//!
//! ## 为什么删掉配对
//!
//! 旧方案是「浏览器 → 服务器 hub → 独立歌词助手」，跨进程跨机器，所以需要
//! 一次性配对码 + 设备令牌。但新客户端里**播放与歌词在同一进程内**，
//! 那套配对纯属历史包袱，还带来「必须先配对才能看歌词」的体验断裂。
//!
//! ## 现在的通道
//!
//! ```text
//! 主窗口页面 ──invoke('lyrics_push_state')──▶ Rust ──emit──▶ 歌词窗渲染
//! 歌词窗按钮 ──invoke('lyrics_send_command')──▶ Rust ──eval──▶ 主窗口页面
//! ```
//!
//! ## 安全边界（重要）
//!
//! 主窗口加载的是**远程站点**。为了不把整个 IPC 面暴露给它，这里只用
//! `app_manifest` 自动生成的 `allow-lyrics-push-state` 这一条权限，
//! 单独挂在一个仅覆盖 `main` + 站点 origin 的 capability 上。
//! 其余命令（配对、设备令牌、穿透控制等）**仍然只有本地窗口能用**。
//!
//! 即：远程页面能做的唯一一件事，就是把「当前在放什么歌、唱到第几秒」
//! 告诉本机歌词窗——这本来就是它自己要显示的东西，不构成越权。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::logging;
use crate::main_window;
use crate::overlay;

/// 歌词窗口监听的状态事件名。
pub const STATE_EVENT: &str = "melodex:lyrics-state";
/// 主窗口页面监听控制命令的 DOM 事件名。
pub const PAGE_COMMAND_EVENT: &str = "melodex:lyrics-command";

/// 歌词状态负载，字段与前端 `playerDesktopLyrics.js` 的既有协议保持一致。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LyricsState {
    /// `"track"` 或 `"progress"`（兼容旧协议命名）。
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub track: Option<serde_json::Value>,
    #[serde(default)]
    pub lyrics: Option<serde_json::Value>,
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub paused: bool,
    #[serde(default, rename = "current_index")]
    pub current_index: i64,
}

impl LyricsState {
    /// 只接受已知类型，挡住脏数据。
    pub fn is_known_kind(&self) -> bool {
        self.kind == "track" || self.kind == "progress"
    }
}

/// 把一条状态转发给歌词窗。
pub fn forward_state<R: Runtime>(app: &AppHandle<R>, state: &LyricsState) {
    let Some(overlay_window) = app.get_webview_window(overlay::OVERLAY_WINDOW) else {
        return;
    };
    if let Err(error) = overlay_window.emit(STATE_EVENT, state) {
        logging::warn(format!("forward lyrics state failed: {error}"));
    }
}

/// 命令白名单，与既有 overlay 按钮一一对应。
fn allowed_command(command: &str) -> bool {
    matches!(command, "prev" | "toggle" | "next")
}

/// 从歌词窗把控制命令送到主窗口页面。
pub fn forward_command<R: Runtime>(app: &AppHandle<R>, command: &str) {
    if !allowed_command(command) {
        logging::warn(format!("ignored unknown lyrics command: {command}"));
        return;
    }
    let Some(main) = app.get_webview_window(main_window::MAIN_WINDOW) else {
        logging::warn("lyrics command ignored: main window missing");
        return;
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent({event}, {{ detail: {{ command: {command} }} }}));",
        event = serde_json::to_string(PAGE_COMMAND_EVENT)
            .unwrap_or_else(|_| "\"melodex:lyrics-command\"".into()),
        command = serde_json::to_string(command).unwrap_or_else(|_| "\"toggle\"".into()),
    );
    if let Err(error) = main.eval(&script) {
        logging::warn(format!("dispatch lyrics command failed: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_kinds() {
        for kind in ["track", "progress"] {
            let state = LyricsState {
                kind: kind.to_string(),
                track: None,
                lyrics: None,
                position: 0.0,
                duration: 0.0,
                paused: true,
                current_index: -1,
            };
            assert!(state.is_known_kind(), "{kind} 应被接受");
        }
    }

    #[test]
    fn rejects_unknown_kinds() {
        let state = LyricsState {
            kind: "evil".to_string(),
            track: None,
            lyrics: None,
            position: 0.0,
            duration: 0.0,
            paused: true,
            current_index: -1,
        };
        assert!(!state.is_known_kind());
    }

    #[test]
    fn command_whitelist_is_exact() {
        for ok in ["prev", "toggle", "next"] {
            assert!(allowed_command(ok), "{ok} 应被允许");
        }
        for bad in ["", "PLAY", "drop", "prev ", "next;evil"] {
            assert!(!allowed_command(bad), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn state_deserializes_from_frontend_shape() {
        let raw = r#"{"type":"track","track":{"id":"1","name":"晴天"},"lyrics":[{"t":0,"text":"x"}],
                      "position":12.5,"duration":269,"paused":false,"current_index":3}"#;
        let state: LyricsState = serde_json::from_str(raw).expect("应能解析前端负载");
        assert_eq!(state.kind, "track");
        assert!((state.position - 12.5).abs() < f64::EPSILON);
        assert_eq!(state.current_index, 3);
        assert!(!state.paused);
        assert!(state.is_known_kind());
    }

    #[test]
    fn progress_state_omits_track_fields() {
        let raw =
            r#"{"type":"progress","position":5,"duration":100,"paused":true,"current_index":-1}"#;
        let state: LyricsState = serde_json::from_str(raw).expect("应能解析");
        assert!(state.track.is_none());
        assert!(state.lyrics.is_none());
        assert_eq!(state.current_index, -1);
    }
}
