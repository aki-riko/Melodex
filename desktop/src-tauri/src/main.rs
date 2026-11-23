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
mod lyrics_bridge;
mod lyrics_settings;
mod main_window;
mod overlay;
mod service_url;
mod settings_window;
mod shortcuts;
mod tray;
mod updates;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // 单实例必须最先注册：第二个实例把已有窗口唤到前台后立即退出。
        .plugin(single_instance::init(|app, _args, _cwd| {
            logging::info("second instance launched, focusing existing window");
            main_window::show_main(app);
        }))
        .plugin(autostart_support::plugin())
        .plugin(shortcuts::plugin())
        .plugin(updater::Builder::new().build())
        .manage(overlay::OverlayState::default())
        .invoke_handler(tauri::generate_handler![
            commands::public_device_config,
            commands::connection_config,
            commands::pair_device,
            commands::clear_pairing,
            commands::set_overlay_visible,
            commands::start_overlay_drag,
            commands::get_click_through,
            commands::overlay_position,
            commands::set_overlay_position,
            commands::overlay_clamp_position,
            commands::lyrics_resize_to_content,
            commands::lyrics_settings_get,
            commands::lyrics_settings_update,
            commands::lyrics_reset_position,
            commands::lyrics_save_position,
            commands::lyrics_push_state,
            commands::lyrics_send_command,
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

            // 设置必须先于托盘加载：托盘勾选项用它的值初始化。
            let settings = lyrics_settings::load(&handle);
            logging::info(format!(
                "lyrics settings loaded (visible={}, click_through={}, font={}, size={}, scheme={})",
                settings.visible,
                settings.click_through,
                settings.font_preset,
                settings.font_size,
                settings.color_scheme
            ));
            app.manage(lyrics_settings::LyricsSettingsState::new(settings.clone()));

            tray::configure_platform(app)?;
            tray::setup_tray(app)?;
            shortcuts::register_defaults(&handle);

            // 启动后延迟做一次静默检查：不打断启动、不自动安装，
            // 发现新版本只在托盘 tooltip 提示。
            let check_handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                updates::spawn_background_check(&check_handle);
            });

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

            overlay::create_overlay_window(&handle, settings.font_size)?;
            // 穿透状态**跟随设置**，不再硬编码 true。
            //
            // 原先写死 true 会导致：设置里选了「未锁定」，重启后又回到穿透，
            // 而穿透状态下鼠标事件到不了歌词窗，控制条（靠 :hover 露出）永远不出现。
            if let Err(error) = overlay::apply_click_through(&handle, settings.click_through) {
                logging::warn(error);
            }

            // 歌词设置窗：默认后台创建不弹出，从托盘「桌面歌词设置…」打开。
            settings_window::create_settings_window(&handle, false)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            main_window::on_window_event(window, event);
            settings_window::on_window_event(window, event);
        })
        .run(tauri::generate_context!())
        .expect("failed to run Melodex desktop shell");
}
