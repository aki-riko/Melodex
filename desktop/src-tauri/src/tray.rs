//! 系统托盘：显示主窗口、鼠标穿透、开机自启、桌面歌词配对、退出。

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

use crate::autostart_support;
use crate::logging;
use crate::main_window;
use crate::overlay;

pub const TRAY_ID: &str = "melodex-tray";

pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "toggle_main", "显示 / 隐藏主窗口", true, None::<&str>)?;
    let pairing_item = MenuItem::with_id(app, "pairing", "桌面歌词配对…", true, None::<&str>)?;
    let click_item = CheckMenuItem::with_id(
        app,
        "click_through",
        "歌词鼠标穿透",
        true,
        true,
        None::<&str>,
    )?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        autostart_support::is_enabled(app.handle()),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &pairing_item,
            &click_item,
            &autostart_item,
            &separator,
            &quit_item,
        ],
    )?;

    let tray_image = Image::from_bytes(include_bytes!("../icons/icon-32.png"))?;
    let click_for_event = click_item.clone();
    let autostart_for_event = autostart_item.clone();

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_image)
        .icon_as_template(false)
        .tooltip("Melodex")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle_main" => main_window::toggle_main(app),
            "pairing" => crate::settings_window::show_settings(app),
            "click_through" => {
                // muda 在派发事件前已切换勾选状态，这里读到的是用户请求的新状态。
                let requested = match click_for_event.is_checked() {
                    Ok(checked) => checked,
                    Err(error) => {
                        logging::error(format!("read click-through menu state failed: {error}"));
                        return;
                    }
                };
                if let Err(error) = overlay::apply_click_through(app, requested) {
                    logging::error(error);
                    if let Err(rollback) = click_for_event.set_checked(!requested) {
                        logging::error(format!("rollback click-through state failed: {rollback}"));
                    }
                }
            }
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

/// 托盘在 macOS 上需要 accessory 激活策略，避免抢占 Dock。
pub fn configure_platform(app: &mut tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.handle()
        .set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}
