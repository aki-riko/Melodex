//! 桌面歌词设备配对与凭据存储。
//!
//! 行为与原 `desktop/src-tauri/src/main.rs` 保持一致（配对码 + 设备令牌 + 文件持久化），
//! 不改动任何已有语义，只是从单文件拆出。
//!
//! 凭据只落在系统分配给本应用的私有配置目录；Unix 下额外收紧到 0600。

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::Duration,
};

use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::service_url::normalize_site_url;

const CONFIG_FILE_NAME: &str = "desktop-lyrics.json";
const CONFIG_DIR_ENV: &str = "MELODEX_DESKTOP_LYRICS_CONFIG_DIR";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeviceConfig {
    pub base_url: String,
    pub device_id: u64,
    pub device_name: String,
    pub device_token: String,
}

#[derive(Debug, Serialize)]
pub struct PublicDeviceConfig {
    pub base_url: String,
    pub device_id: u64,
    pub device_name: String,
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

pub fn app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os(CONFIG_DIR_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(directory).join(CONFIG_FILE_NAME));
    }
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(CONFIG_FILE_NAME))
        .map_err(|error| format!("读取应用配置目录失败：{error}"))
}

pub fn load_device_config(app: &AppHandle) -> Result<Option<DeviceConfig>, String> {
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

pub fn save_device_config(app: &AppHandle, config: &DeviceConfig) -> Result<(), String> {
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
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("保存桌面歌词配置失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("收紧桌面歌词配置权限失败：{error}"))?;
    }
    file.write_all(&bytes)
        .map_err(|error| format!("写入桌面歌词配置失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步桌面歌词配置失败：{error}"))
}

pub fn remove_device_config(app: &AppHandle) -> Result<(), String> {
    let path = app_config_path(app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("移除桌面歌词配置失败：{error}")),
    }
}

pub fn native_device_name() -> &'static str {
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

/// 用一次性配对码换取设备令牌。
pub async fn pair_device(
    app: &AppHandle,
    service_url: &str,
    code: &str,
) -> Result<PublicDeviceConfig, String> {
    let base_url = normalize_site_url(service_url)?;
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
    save_device_config(app, &config)?;
    Ok(PublicDeviceConfig::from(&config))
}
