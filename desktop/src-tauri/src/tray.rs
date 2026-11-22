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
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
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
        true,
        settings.click_through,
        None::<&str>,
    )?;
    let pairing_item = MenuItem::with_id(app, "pairing", "桌面歌词设置…", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        autostart_support::is_enabled(app.handle()),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    // 快捷键说明是只读提示项：点击不做事，仅让用户知道有这些键可用。
    let shortcuts_item = MenuItem::with_id(
        app,
        "shortcuts_hint",
        format!("快捷键  {}", shortcuts::describe().replace('\n', " / ")),
        false,
        None::<&str>,
    )?;
    let update_item = MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &lyrics_visible_item,
            &click_item,
            &pairing_item,
            &autostart_item,
            &shortcuts_item,
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
        .show_menu_on_left_click(true)
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
            "pairing" => crate::settings_window::show_settings(app),
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
    match lyrics_settings::apply_patch(app, &state, &patch) {
        Ok(updated) => {
            // 可见性立刻作用到窗口（没有歌词时保持隐藏，避免闪空窗）。
            let _ = overlay::set_overlay_visible(
                app,
                updated.visible && overlay::has_lyrics_state(app),
            );
            if let Err(error) = overlay::apply_click_through(app, updated.click_through) {
                logging::error(format!("应用歌词穿透失败：{error}"));
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
