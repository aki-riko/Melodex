//! 全局快捷键：应用失焦时也能控制播放。
//!
//! 实现方式刻意最简：快捷键触发后用 `eval` 往页面派发一个 `CustomEvent`，
//! 由前端薄桥接（`frontend/src/platform/desktopShell.js`）转成播放器动作。
//! 这样壳**完全不需要理解播放器状态**，也不必为远程页面开放任何 IPC 权限。
//!
//! 默认键位：
//! - `Ctrl+Alt+Space` 播放 / 暂停
//! - `Ctrl+Alt+Left`  上一首
//! - `Ctrl+Alt+Right` 下一首
//!
//! 选择 Ctrl+Alt 组合是为了避开系统媒体键（那由 WebView2 内核对 MediaSession 直通处理）
//! 与常见软件冲突。

use global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri::{AppHandle, Manager, Runtime};

use crate::logging;
use crate::main_window;

/// 前端监听的 DOM 事件名。
pub const EVENT_NAME: &str = "melodex:shell-shortcut";

pub const ACTION_PLAY_PAUSE: &str = "toggle";
pub const ACTION_PREV: &str = "prev";
pub const ACTION_NEXT: &str = "next";

/// 键位与动作的**唯一**对照表。注册与派发都查它，避免两处写死不同字符串。
const BINDINGS: [(&str, &str); 3] = [
    ("Ctrl+Alt+Space", ACTION_PLAY_PAUSE),
    ("Ctrl+Alt+Left", ACTION_PREV),
    ("Ctrl+Alt+Right", ACTION_NEXT),
];

/// 构造插件并挂上处理器。
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            // 只在按下时动作，避免"按下 + 抬起"触发两次。
            if event.state != ShortcutState::Pressed {
                return;
            }
            on_shortcut(app, shortcut);
        })
        .build()
}

/// 把触发到的 shortcut 解析成动作名。
///
/// 不依赖 `Shortcut` 的字符串格式化结果，而是把它与已注册的键位逐一比较，
/// 这样插件内部表示变化也不会让映射失配。
fn action_for<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut) -> Option<&'static str> {
    for (key, action) in BINDINGS {
        let Ok(parsed) = key.parse::<Shortcut>() else {
            continue;
        };
        if &parsed == shortcut {
            return Some(action);
        }
    }
    // 退化路径：比较字符串（部分平台会规范化键序）。
    let raw = shortcut.to_string();
    BINDINGS
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(&raw))
        .map(|(_, action)| *action)
        .inspect(|_| {
            let _ = app;
        })
}

fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut) {
    let Some(action) = action_for(app, shortcut) else {
        logging::warn(format!("unmapped global shortcut: {shortcut}"));
        return;
    };
    logging::info(format!("global shortcut {shortcut} -> {action}"));

    let Some(window) = app.get_webview_window(main_window::MAIN_WINDOW) else {
        logging::warn("global shortcut ignored: main window missing");
        return;
    };

    let script = format!(
        "window.dispatchEvent(new CustomEvent({event}, {{ detail: {{ action: {action} }} }}));",
        event = serde_json::to_string(EVENT_NAME)
            .unwrap_or_else(|_| "\"melodex:shell-shortcut\"".into()),
        action = serde_json::to_string(action).unwrap_or_else(|_| "\"toggle\"".into()),
    );
    if let Err(error) = window.eval(&script) {
        logging::warn(format!("dispatch shortcut event failed: {error}"));
    }
}

/// 注册默认快捷键。某个键位被别的程序占用时只记日志、不阻断启动。
pub fn register_defaults<R: Runtime>(app: &AppHandle<R>) {
    let manager = app.global_shortcut();
    for (key, action) in BINDINGS {
        match manager.register(key) {
            Ok(()) => logging::info(format!("registered global shortcut {key} -> {action}")),
            Err(error) => logging::warn(format!("register global shortcut {key} failed: {error}")),
        }
    }
}

/// 动作的中文名。未知动作原样返回，避免以后新增键位时静默丢标签。
fn label_for_action(action: &str) -> &str {
    match action {
        ACTION_PLAY_PAUSE => "播放 / 暂停",
        ACTION_PREV => "上一首",
        ACTION_NEXT => "下一首",
        other => other,
    }
}

/// 供 UI 展示的「键位 + 动作名」清单，顺序与 [`BINDINGS`] 一致。
///
/// 托盘用它**逐个**生成菜单项（收进「播放快捷键」子菜单）。
/// 曾经的写法是把三条键位拼成一整条禁用项 `快捷键  A / B / C`：
/// Windows 托盘菜单按最长条目定宽，实测把整个菜单撑到约 770px，
/// 其余条目全被甩到左侧一条缝里 —— 不要再拼成一条。
pub fn listing() -> impl Iterator<Item = (&'static str, &'static str)> {
    BINDINGS
        .iter()
        .map(|(key, action)| (*key, label_for_action(action)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_parse_as_shortcuts() {
        for (key, _) in BINDINGS {
            assert!(key.parse::<Shortcut>().is_ok(), "{key} 应可解析");
        }
    }

    #[test]
    fn bindings_have_unique_keys_and_actions() {
        let mut keys: Vec<&str> = BINDINGS.iter().map(|(key, _)| *key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), BINDINGS.len(), "键位不得重复");

        let mut actions: Vec<&str> = BINDINGS.iter().map(|(_, action)| *action).collect();
        actions.sort_unstable();
        actions.dedup();
        assert_eq!(actions.len(), BINDINGS.len(), "动作不得重复");
    }

    #[test]
    fn listing_covers_every_binding_with_labels() {
        let listing: Vec<_> = listing().collect();
        assert_eq!(listing.len(), BINDINGS.len(), "每条键位都应出现在清单里");
        for ((key, label), (bound_key, _)) in listing.iter().zip(BINDINGS.iter()) {
            assert_eq!(key, bound_key, "清单顺序必须与 BINDINGS 一致");
            assert!(!label.is_empty(), "{key} 必须有可读的中文名");
            // 未知动作会原样返回动作字符串，说明漏配了标签。
            assert!(
                !label.is_ascii(),
                "{key} 的动作名没配中文标签（拿到的是 {label}）"
            );
        }
    }

    /// 门禁：菜单项文本必须保持单条短小。
    ///
    /// Windows 托盘菜单按最长条目决定整体宽度。把三条键位拼成一条会让菜单
    /// 被撑到 ~770px（用户实测截图），其余条目被甩到左侧一条缝里。
    #[test]
    fn each_listing_entry_is_short_enough_for_a_menu_item() {
        for (key, label) in listing() {
            let text = format!("{label}    {key}");
            // 一条菜单项的合理上限；超过就说明又在往单条里塞多条内容。
            assert!(
                text.chars().count() <= 28,
                "菜单项「{text}」过长（{} 字符），会撑宽整个托盘菜单",
                text.chars().count()
            );
        }
    }
}
