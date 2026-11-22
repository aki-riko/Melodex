//! 主窗口：加载线上 PWA 站点，导航留在白名单内，关闭时最小化到托盘。
//!
//! 设计要点：
//! - 页面不打包进安装包，壳加载线上站点 → 前端部署即更新，不需重发安装包。
//! - 导航护栏：只允许站点同源 + 登录网关同源，其余外链交给系统浏览器。
//! - 关闭按钮不退出进程：隐藏窗口，媒体播放不受影响（与托盘配合）。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::logging;
use crate::service_url;

pub const MAIN_WINDOW: &str = "main";

/// 主窗口是否已允许真正退出。托盘「退出」会置位。
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

pub fn allow_exit() {
    ALLOW_EXIT.store(true, Ordering::SeqCst);
}

pub fn exit_allowed() -> bool {
    ALLOW_EXIT.load(Ordering::SeqCst)
}

/// 构建主窗口。
///
/// `visible=false` 用于开机自启的静默启动：进程起来但不抢焦点、不闪窗。
pub fn create_main_window(
    app: &AppHandle,
    site: &Url,
    visible: bool,
) -> tauri::Result<WebviewWindow> {
    let nav_site = site.clone();
    let login_origin = derive_login_origin(site);

    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(site.clone()))
        .title("Melodex")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .visible(visible)
        .on_navigation(move |url| {
            if service_url::navigation_allowed(url, &nav_site, login_origin.as_ref()) {
                return true;
            }
            logging::warn(format!("blocked external navigation: {url}"));
            open_externally(url);
            false
        })
        .build()
}

/// 推导登录网关 origin，仅用于导航白名单（不发起任何请求）。
///
/// 生产环境 Authentik 与站点位于同一父域的不同子域。为限制攻击面，
/// 只在父域为自有域名时放行 `auth.<parent>`；推导失败则返回 None，
/// 此时壳内只允许站点同源导航。
fn derive_login_origin(site: &Url) -> Option<Url> {
    let host = site.host_str()?;
    let mut labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 3 {
        return None;
    }
    let parent = labels.split_off(labels.len() - 2).join(".");
    if parent != "9li.life" {
        return None;
    }
    Url::parse(&format!("https://auth.{parent}/")).ok()
}

fn open_externally(url: &Url) {
    // 交给系统默认浏览器。失败只记日志，不弹窗打断媒体播放。
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url.as_str()).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open")
        .arg(url.as_str())
        .spawn();

    if let Err(error) = spawned {
        logging::warn(format!("open external url failed: {error}"));
    }
}

/// 显示并聚焦主窗口。
pub fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        logging::warn("main window missing");
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 托盘/单实例用的显示-隐藏切换。
pub fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        match service_url::resolve_site() {
            Ok(site) => {
                if let Err(error) = create_main_window(app, &site, true) {
                    logging::error(format!("recreate main window failed: {error}"));
                }
            }
            Err(error) => logging::error(format!("resolve site failed: {error}")),
        }
        return;
    };
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => show_main(app),
    }
}

/// 窗口事件统一入口，供 `on_window_event` 调用。
///
/// Tauri 的 `on_window_event` 回调给的是 `&Window`（不是 `&WebviewWindow`），
/// 这里直接按 `Window` 处理，避免类型不匹配。
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        if exit_allowed() {
            return;
        }
        api.prevent_close();
        let _ = window.hide();
        logging::info("main window hidden to tray (close intercepted)");
    }
}
