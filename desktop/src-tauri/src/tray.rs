//! 系统托盘：显示主窗口、桌面歌词显示/锁定、开机自启、检查更新、退出。
//!
//! 勾选项与设置文件双向同步：
//! - 用户点托盘 → 走 `lyrics_settings::apply_patch` 落盘，再由 `sync_check_items` 回写勾选；
//! - 用户在设置页/歌词窗改 → `apply_patch` 也会调 `sync_check_items`，托盘不会和实际状态脱节。
//!
//! 旧 PrismQML 实现同样有两项勾选（`main.py` 的「显示桌面歌词」与「锁定桌面歌词」），
//! 这里保持一致的语义，避免用户关掉歌词后找不到重新打开的入口。

use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconId},
    AppHandle, Manager, Wry,
};

use crate::autostart_support;
use crate::logging;
use crate::lyrics_settings::{self, LyricsSettings};
use crate::main_window;
use crate::overlay;
use crate::shortcuts;

pub const TRAY_ID: &str = "melodex-tray";

/// 需要随设置变化而更新的勾选项。
///
/// 托盘没有「按 id 取菜单项」的公开接口，所以必须在创建时留一份克隆；
/// `CheckMenuItem` 内部是共享指针，克隆持有的是同一个菜单项对象。
struct LyricsCheckItems {
    visible: CheckMenuItem<Wry>,
    click_through: CheckMenuItem<Wry>,
}

static LYRICS_ITEMS: Mutex<Option<LyricsCheckItems>> = Mutex::new(None);

/// 「锁定桌面歌词」是否可操作。
///
/// 歌词没显示时锁定一个不存在的窗口没有意义，所以置灰。
/// 这也顺带解决了两个勾选项**方向相反还并列**的观感问题：
/// 关掉歌词后「锁定」自动变灰，不会再出现「两个都打勾像自相矛盾」。
fn lock_available(settings: &LyricsSettings) -> bool {
    settings.visible
}

/// 按设置同步托盘勾选状态。任何一处改了设置都应调用它。
pub fn sync_check_items(app: &AppHandle, settings: &LyricsSettings) {
    let guard = match LYRICS_ITEMS.lock() {
        Ok(guard) => guard,
        Err(_) => {
            logging::warn("托盘勾选状态锁已中毒，跳过同步");
            return;
        }
    };
    let Some(items) = guard.as_ref() else {
        // 托盘还没建好（例如启动早期广播）：不报错，托盘创建时会读设置初始化。
        return;
    };
    if let Err(error) = items.visible.set_checked(settings.visible) {
        logging::error(format!("同步托盘「显示桌面歌词」勾选失败：{error}"));
    }
    if let Err(error) = items.click_through.set_checked(settings.click_through) {
        logging::error(format!("同步托盘「锁定桌面歌词」勾选失败：{error}"));
    }
    if let Err(error) = items.click_through.set_enabled(lock_available(settings)) {
        logging::error(format!("同步托盘「锁定桌面歌词」可用性失败：{error}"));
    }
    let _ = app;
}

pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let settings = lyrics_settings::load(app.handle());

    let show_item = MenuItem::with_id(app, "toggle_main", "显示 / 隐藏主窗口", true, None::<&str>)?;
    // 与旧实现一致：关掉歌词后在这里重新打开。
    let lyrics_visible_item = CheckMenuItem::with_id(
        app,
        "lyrics_visible",
        "显示桌面歌词",
        true,
        settings.visible,
        None::<&str>,
    )?;
    let click_item = CheckMenuItem::with_id(
        app,
        "click_through",
        "锁定桌面歌词（鼠标穿透）",
        // 歌词没显示时锁定没有意义，一并置灰（与 sync_check_items 同一判据）。
        lock_available(&settings),
        settings.click_through,
        None::<&str>,
    )?;
    // 窗口 id 曾叫 "pairing"：这个菜单项原先是「设备配对」，配对流程早已删除，
    // 窗口改作歌词设置页（见 AGENTS.md「桌面歌词：壳内直连」）。
    let settings_item =
        MenuItem::with_id(app, "lyrics_settings", "桌面歌词设置…", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        autostart_support::is_enabled(app.handle()),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    // 快捷键说明收进子菜单。
    //
    // 曾经把它压成**一条**禁用项（`快捷键  A  /  B  /  C`），Windows 托盘菜单按
    // 最长条目定宽，实测把整个菜单撑到约 770px，其余条目全被甩在左侧一条缝里。
    // 现在每条键位各自成项，顶层菜单宽度只由这些短标签决定。
    //
    // 注意：**不能**用 MenuItem 的 accelerator 参数来显示键位 —— muda 会把它注册进
    // Windows 快捷键表（tauri 的 msg_hook 会跑 TranslateAcceleratorW），
    // 与 global_shortcut 插件注册的同一组合键双触发。
    let shortcut_items = shortcuts::listing()
        .map(|(key, label)| {
            MenuItem::with_id(
                app,
                format!("shortcut_hint:{key}"),
                format!("{label}    {key}"),
                false,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let shortcut_refs = shortcut_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<Wry>)
        .collect::<Vec<_>>();
    let shortcuts_submenu =
        Submenu::with_id_and_items(app, "shortcuts_submenu", "播放快捷键", true, &shortcut_refs)?;
    let update_item = MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &lyrics_visible_item,
            &click_item,
            &settings_item,
            &autostart_item,
            &shortcuts_submenu,
            &separator,
            &update_item,
            &quit_item,
        ],
    )?;

    let tray_image = Image::from_bytes(include_bytes!("../icons/icon-32.png"))?;
    let click_for_event = click_item.clone();
    let visible_for_event = lyrics_visible_item.clone();
    let autostart_for_event = autostart_item.clone();

    {
        let mut guard = match LYRICS_ITEMS.lock() {
            Ok(guard) => guard,
            Err(_) => {
                logging::error("托盘勾选状态锁已中毒，勾选项将无法与设置同步");
                return Ok(());
            }
        };
        *guard = Some(LyricsCheckItems {
            visible: lyrics_visible_item.clone(),
            click_through: click_item.clone(),
        });
    }

    let tray_id = TrayIconId::new(TRAY_ID);
    TrayIconBuilder::with_id(tray_id)
        .icon(tray_image)
        .icon_as_template(false)
        .tooltip("Melodex")
        .menu(&menu)
        // 左键只切换主窗口、右键才出菜单（Windows 托盘惯例）。
        // 原先左键同时做两件事：既弹菜单（这里为 true）又 toggle_main（见下方事件处理），
        // 两个动作抢同一个左键。
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle_main" => main_window::toggle_main(app),
            "lyrics_visible" => {
                // muda 在派发事件前已切换勾选状态，这里读到的是用户请求的新状态。
                match visible_for_event.is_checked() {
                    Ok(requested) => apply_lyrics_patch(
                        app,
                        lyrics_settings::LyricsSettingsPatch {
                            visible: Some(requested),
                            ..Default::default()
                        },
                        Some((&visible_for_event, !requested)),
                    ),
                    Err(error) => logging::error(format!("读取歌词显示勾选失败：{error}")),
                }
            }
            "click_through" => match click_for_event.is_checked() {
                Ok(requested) => apply_lyrics_patch(
                    app,
                    lyrics_settings::LyricsSettingsPatch {
                        click_through: Some(requested),
                        ..Default::default()
                    },
                    Some((&click_for_event, !requested)),
                ),
                Err(error) => logging::error(format!("读取歌词锁定勾选失败：{error}")),
            },
            "lyrics_settings" => crate::settings_window::show_settings(app),
            "check_update" => crate::updates::interactive_check(app),
            "autostart" => {
                let requested = match autostart_for_event.is_checked() {
                    Ok(checked) => checked,
                    Err(error) => {
                        logging::error(format!("read autostart menu state failed: {error}"));
                        return;
                    }
                };
                if let Err(error) = autostart_support::set_enabled(app, requested) {
                    logging::error(error);
                    if let Err(rollback) = autostart_for_event.set_checked(!requested) {
                        logging::error(format!("rollback autostart state failed: {rollback}"));
                    }
                }
            }
            "quit" => {
                main_window::allow_exit();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击切换主窗口；右键由菜单接管。
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                main_window::toggle_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 落盘一处歌词设置，失败时回滚对应勾选。
fn apply_lyrics_patch(
    app: &AppHandle,
    patch: lyrics_settings::LyricsSettingsPatch,
    rollback: Option<(&CheckMenuItem<Wry>, bool)>,
) {
    let state = app.state::<lyrics_settings::LyricsSettingsState>();
    // 与 commands::lyrics_settings_update 同样的纪律：只有显式改了 visible 才动窗口显隐。
    // 否则「锁定桌面歌词」（只改 click_through）在暂停时会把窗口隐藏——
    // 用户看到的就是「点了锁定，歌词没了」。
    let visibility_changed = patch.visible.is_some();
    match lyrics_settings::apply_patch(app, &state, &patch) {
        Ok(updated) => {
            if visibility_changed {
                // 没有歌词时保持隐藏，避免闪一个空窗。
                let _ = overlay::set_overlay_visible(
                    app,
                    updated.visible && overlay::has_lyrics_state(app),
                );
            }
            if patch.click_through.is_some() {
                if let Err(error) = overlay::apply_click_through(app, updated.click_through) {
                    logging::error(format!("应用歌词穿透失败：{error}"));
                }
            }
        }
        Err(error) => {
            logging::error(format!("保存歌词设置失败：{error}"));
            if let Some((item, value)) = rollback {
                if let Err(rollback_error) = item.set_checked(value) {
                    logging::error(format!("回滚托盘勾选失败：{rollback_error}"));
                }
            }
        }
    }
}

/// 托盘在 macOS 上需要 accessory 激活策略，避免抢占 Dock。
pub fn configure_platform(app: &mut tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.handle()
        .set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(visible: bool, click_through: bool) -> LyricsSettings {
        LyricsSettings {
            visible,
            click_through,
            ..Default::default()
        }
    }

    /// 歌词没显示时「锁定」必须置灰。
    ///
    /// 没有这条约束，两个语义**相反**的勾选项会并排出现（显示=要它出现、
    /// 锁定=别理鼠标），都打勾时用户看到的是自相矛盾的状态。
    #[test]
    fn lock_is_unavailable_when_lyrics_hidden() {
        assert!(!lock_available(&settings_with(false, false)));
        assert!(!lock_available(&settings_with(false, true)));
        assert!(lock_available(&settings_with(true, false)));
        assert!(lock_available(&settings_with(true, true)));
    }

    /// 判据只取决于「显示」，与锁定自身取值无关 —— 否则关掉歌词但保留锁定状态时
    /// 会算出"可用"，锁定项又亮起来。
    #[test]
    fn lock_availability_ignores_its_own_value() {
        let locked_but_hidden = settings_with(false, true);
        let unlocked_and_hidden = settings_with(false, false);
        assert_eq!(
            lock_available(&locked_but_hidden),
            lock_available(&unlocked_and_hidden)
        );
    }
}
