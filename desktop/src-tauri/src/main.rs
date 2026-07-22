#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::IpAddr,
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};

const CONFIG_FILE_NAME: &str = "desktop-lyrics.json";
const CONFIG_DIR_ENV: &str = "MELODEX_DESKTOP_LYRICS_CONFIG_DIR";
const SETTINGS_WINDOW: &str = "settings";
const OVERLAY_WINDOW: &str = "overlay";

struct RuntimeState {
    click_through: Mutex<bool>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            click_through: Mutex::new(true),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DeviceConfig {
    base_url: String,
    device_id: u64,
    device_name: String,
    device_token: String,
}

#[derive(Debug, Serialize)]
struct PublicDeviceConfig {
    base_url: String,
    device_id: u64,
    device_name: String,
}

impl From<&DeviceConfig> for PublicDeviceConfig {
    fn from(value: &DeviceConfig) -> Self {
        Self {
            base_url: value.base_url.clone(),
            device_id: value.device_id,
            device_name: value.device_name.clone(),
        }
    }
}

#[derive(Serialize)]
struct PairRequest<'a> {
    code: &'a str,
    device_name: &'a str,
}

#[derive(Deserialize)]
struct PairResponse {
    device_id: u64,
    device_token: String,
    device_name: String,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: Option<String>,
}

fn app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os(CONFIG_DIR_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(directory).join(CONFIG_FILE_NAME));
    }
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(CONFIG_FILE_NAME))
        .map_err(|error| format!("读取应用配置目录失败：{error}"))
}

fn load_device_config(app: &AppHandle) -> Result<Option<DeviceConfig>, String> {
    let path = app_config_path(app)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取桌面歌词配置失败：{error}")),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("桌面歌词配置已损坏：{error}"))
}

fn save_device_config(app: &AppHandle, config: &DeviceConfig) -> Result<(), String> {
    let path = app_config_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "桌面歌词配置目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建桌面歌词配置目录失败：{error}"))?;
    let bytes =
        serde_json::to_vec(config).map_err(|error| format!("序列化桌面歌词配置失败：{error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("保存桌面歌词配置失败：{error}"))?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("收紧桌面歌词配置权限失败：{error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("写入桌面歌词配置失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步桌面歌词配置失败：{error}"))
}

fn remove_device_config(app: &AppHandle) -> Result<(), String> {
    let path = app_config_path(app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("移除桌面歌词配置失败：{error}")),
    }
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => false,
    }
}

fn normalize_service_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("请填写 Melodex 服务地址".to_string());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = Url::parse(&candidate).map_err(|error| format!("服务地址格式不正确：{error}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("服务地址只支持 HTTPS；本机调试可使用 HTTP".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("服务地址不能包含账号或密码".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "服务地址缺少主机名".to_string())?;
    if url.scheme() == "http" && !is_loopback_host(host) {
        return Err("非本机服务必须使用 HTTPS，避免设备令牌被明文窃取".to_string());
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn native_device_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Windows 桌面歌词"
    }
    #[cfg(target_os = "macos")]
    {
        "macOS 桌面歌词"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "桌面歌词助手"
    }
}

fn notify_overlay_config_changed(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW) {
        if let Err(error) = window.emit("desktop-config-changed", ()) {
            eprintln!("notify overlay config change failed: {error}");
        }
    }
}

#[tauri::command]
fn public_device_config(app: AppHandle) -> Result<Option<PublicDeviceConfig>, String> {
    load_device_config(&app).map(|config| config.as_ref().map(PublicDeviceConfig::from))
}

#[tauri::command]
fn connection_config(app: AppHandle) -> Result<Option<DeviceConfig>, String> {
    load_device_config(&app)
}

#[tauri::command]
async fn pair_device(
    app: AppHandle,
    service_url: String,
    code: String,
) -> Result<PublicDeviceConfig, String> {
    let base_url = normalize_service_url(&service_url)?;
    let pairing_code = code.trim().to_uppercase();
    if pairing_code.is_empty() {
        return Err("请填写一次性配对码".to_string());
    }
    let endpoint = base_url
        .join("/rest/desktop-lyrics/pair")
        .map_err(|error| format!("生成配对接口地址失败：{error}"))?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("初始化安全网络客户端失败：{error}"))?;
    let response = client
        .post(endpoint)
        .json(&PairRequest {
            code: &pairing_code,
            device_name: native_device_name(),
        })
        .send()
        .await
        .map_err(|error| format!("连接 Melodex 失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 Melodex 配对响应失败：{error}"))?;
    if !status.is_success() {
        let message = match serde_json::from_str::<ErrorResponse>(&body) {
            Ok(error) => error
                .error
                .unwrap_or_else(|| format!("配对失败（HTTP {status}）")),
            Err(_) => format!("配对失败（HTTP {status}）"),
        };
        return Err(message);
    }
    let paired: PairResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Melodex 配对响应格式错误：{error}"))?;
    if paired.device_id == 0 || paired.device_token.trim().is_empty() {
        return Err("Melodex 未返回有效设备凭据".to_string());
    }
    let config = DeviceConfig {
        base_url: base_url.to_string(),
        device_id: paired.device_id,
        device_name: paired.device_name,
        device_token: paired.device_token,
    };
    save_device_config(&app, &config)?;
    notify_overlay_config_changed(&app);
    Ok(PublicDeviceConfig::from(&config))
}

#[tauri::command]
fn clear_pairing(app: AppHandle) -> Result<(), String> {
    remove_device_config(&app)?;
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW) {
        window
            .hide()
            .map_err(|error| format!("隐藏歌词窗口失败：{error}"))?;
    }
    notify_overlay_config_changed(&app);
    Ok(())
}

#[tauri::command]
fn set_overlay_visible(app: AppHandle, visible: bool) -> Result<(), String> {
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

#[tauri::command]
fn start_overlay_drag(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?
        .start_dragging()
        .map_err(|error| format!("移动歌词窗口失败：{error}"))
}

#[tauri::command]
fn get_click_through(state: State<'_, RuntimeState>) -> Result<bool, String> {
    state
        .click_through
        .lock()
        .map(|value| *value)
        .map_err(|_| "读取鼠标穿透状态失败".to_string())
}

fn apply_click_through(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(OVERLAY_WINDOW)
        .ok_or_else(|| "歌词窗口不存在".to_string())?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| format!("切换鼠标穿透失败：{error}"))?;
    let state = app.state::<RuntimeState>();
    let mut stored = state
        .click_through
        .lock()
        .map_err(|_| "保存鼠标穿透状态失败".to_string())?;
    *stored = enabled;
    window
        .emit("click-through-changed", enabled)
        .map_err(|error| format!("通知鼠标穿透状态失败：{error}"))
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        if let Err(error) = window.show() {
            eprintln!("show settings window failed: {error}");
            return;
        }
        if let Err(error) = window.set_focus() {
            eprintln!("focus settings window failed: {error}");
        }
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show_settings", "显示设置", true, None::<&str>)?;
    let click_item =
        CheckMenuItem::with_id(app, "click_through", "鼠标穿透", true, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &click_item, &separator, &quit_item])?;
    let tray_image = Image::from_bytes(include_bytes!("../icons/icon-32.png"))?;
    let click_item_for_event = click_item.clone();
    TrayIconBuilder::with_id("desktop-lyrics")
        .icon(tray_image)
        .icon_as_template(false)
        .tooltip("Melodex 桌面歌词")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show_settings" => show_settings(app),
            "click_through" => {
                // muda 会在派发菜单事件前先切换 CheckMenuItem 的勾选状态，
                // 因此这里读到的就是用户请求的新状态，不能再次取反。
                let requested = match click_item_for_event.is_checked() {
                    Ok(checked) => checked,
                    Err(error) => {
                        eprintln!("read click-through menu state failed: {error}");
                        return;
                    }
                };
                if let Err(error) = apply_click_through(app, requested) {
                    eprintln!("{error}");
                    if let Err(rollback_error) = click_item_for_event.set_checked(!requested) {
                        eprintln!("rollback click-through menu state failed: {rollback_error}");
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            public_device_config,
            connection_config,
            pair_device,
            clear_pairing,
            set_overlay_visible,
            start_overlay_drag,
            get_click_through
        ])
        .setup(|app| {
            setup_tray(app)?;
            #[cfg(target_os = "macos")]
            app.handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)?;

            let handle = app.handle().clone();
            apply_click_through(&handle, true).map_err(std::io::Error::other)?;
            match load_device_config(&handle) {
                Ok(Some(_)) => {
                    if let Some(settings) = app.get_webview_window(SETTINGS_WINDOW) {
                        settings.hide()?;
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("load desktop lyrics config on startup failed: {error}"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == SETTINGS_WINDOW {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("hide settings window failed: {error}");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Melodex desktop lyrics helper");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_https_service_root() {
        let url = normalize_service_url("music.example.test/some/path?ignored=1").expect("url");
        assert_eq!(url.as_str(), "https://music.example.test/");
    }

    #[test]
    fn permits_loopback_http_for_local_development() {
        let url = normalize_service_url("http://127.0.0.1:8329/music").expect("url");
        assert_eq!(url.as_str(), "http://127.0.0.1:8329/");
    }

    #[test]
    fn rejects_cleartext_remote_service() {
        let error =
            normalize_service_url("http://music.example.test").expect_err("must reject HTTP");
        assert!(error.contains("必须使用 HTTPS"));
    }

    #[test]
    fn rejects_embedded_credentials() {
        let error = normalize_service_url("https://user:pass@music.example.test")
            .expect_err("must reject credentials");
        assert!(error.contains("不能包含账号或密码"));
    }
}
