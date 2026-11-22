#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Melodex 桌面壳：用 Tauri 2 包裹 Melodex PWA。
//!
//! 页面不打包进安装包，壳直接加载线上站点，因此前端部署即更新、无需重发安装包。
//! 原生能力（托盘、桌面歌词、开机自启、单实例、媒体键透传）在 Rust 侧实现；
//! 媒体键依赖 WebView2 内核对 MediaSession 的直通，已在阶段 0 真机验证。

mod autostart_support;
mod commands;
mod device;
mod logging;
mod main_window;
mod overlay;
mod service_url;
mod settings_window;
mod tray;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // 单实例必须最先注册：第二个实例把已有窗口唤到前台后立即退出。
        .plugin(single_instance::init(|app, _args, _cwd| {
            logging::info("second instance launched, focusing existing window");
            main_window::show_main(app);
        }))
        .plugin(autostart_support::plugin())
        .manage(overlay::OverlayState::default())
        .invoke_handler(tauri::generate_handler![
            commands::public_device_config,
            commands::connection_config,
            commands::pair_device,
            commands::clear_pairing,
            commands::set_overlay_visible,
            commands::start_overlay_drag,
            commands::get_click_through,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            if let Ok(dir) = handle.path().app_log_dir() {
                logging::init(dir);
            }
            logging::info(format!(
                "melodex desktop shell starting (autostart={})",
                autostart_support::launched_by_autostart()
            ));

            tray::configure_platform(app)?;
            tray::setup_tray(app)?;

            let site = match service_url::resolve_site() {
                Ok(site) => site,
                Err(error) => {
                    // 站点配置非法时不要静默失败：记录下来并仍然起窗口，
                    // 让用户看到明确错误而不是"双击没反应"。
                    logging::error(format!("resolve site failed: {error}"));
                    return Err(Box::<dyn std::error::Error>::from(error));
                }
            };
            logging::info(format!("main window loading {site}"));

            // 开机自启时静默启动：不抢焦点、不闪窗；用户点托盘即可展开。
            let visible = !autostart_support::launched_by_autostart();
            main_window::create_main_window(&handle, &site, visible)?;

            overlay::create_overlay_window(&handle)?;
            // 默认鼠标穿透，与既有行为一致。
            if let Err(error) = overlay::apply_click_through(&handle, true) {
                logging::warn(error);
            }

            // 配对设置窗：已配对则后台创建（隐藏）；未配对则直接显示，
            // 让用户能立刻完成「设置 → 桌面歌词」的配对流程。
            match device::load_device_config(&handle) {
                Ok(Some(_)) => settings_window::create_settings_window(&handle, false)?,
                Ok(None) => settings_window::create_settings_window(&handle, true)?,
                Err(error) => {
                    logging::warn(error);
                    settings_window::create_settings_window(&handle, true)?;
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            main_window::on_window_event(window, event);
            settings_window::on_window_event(window, event);
        })
        .run(tauri::generate_context!())
        .expect("failed to run Melodex desktop shell");
}
