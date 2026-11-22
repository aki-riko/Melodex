//! 自动更新：检查、下载、安装。
//!
//! 设计要点：
//! - 更新**不自动静默执行**。启动后台静默*检查*，发现新版本只在托盘标题提示；
//!   真正下载安装必须由用户点托盘菜单触发，避免在播放中突然重启。
//! - Windows 上 `download_and_install` 成功后**直接退出进程**，因此必须先
//!   把"允许退出"置位，否则关闭拦截逻辑会与之打架。
//! - 公钥由 `tauri.conf.json` 的 `plugins.updater.pubkey` 提供（可公开）；
//!   私钥只在构建时通过 `TAURI_SIGNING_PRIVATE_KEY` 环境变量注入，**绝不入库**。

use tauri::{AppHandle, Runtime};
use updater::UpdaterExt;

use crate::logging;
use crate::main_window;

/// 启动后台静默检查。发现新版本只写日志并更新托盘提示，不打断播放。
pub fn spawn_background_check<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&handle).await {
            Ok(Some(version)) => {
                logging::info(format!("update available: {version}"));
                update_tray_hint(&handle, Some(&version));
            }
            Ok(None) => logging::info("no update available"),
            Err(error) => logging::warn(format!("update check failed: {error}")),
        }
    });
}

/// 检查是否有新版本。返回 `Some(version)` 表示可用。
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let updater = app
        .updater()
        .map_err(|error| format!("初始化更新器失败：{error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;
    Ok(update.map(|value| value.version.to_string()))
}

/// 下载并安装更新。
///
/// 调用方必须已经完成用户确认；本函数不弹任何窗口。
pub async fn download_and_install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|error| format!("初始化更新器失败：{error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
    else {
        return Err("已是最新版本".to_string());
    };

    let version = update.version.to_string();
    logging::info(format!("downloading update {version}"));

    let mut downloaded = 0usize;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk;
                if let Some(total) = total {
                    // total 是 u64；只在"下载完成"这一刻记一行，避免逐块刷屏。
                    if downloaded as u64 >= total {
                        logging::info(format!("update download complete ({total} bytes)"));
                    }
                }
            },
            || logging::info("update downloaded, launching installer"),
        )
        .await
        .map_err(|error| format!("安装更新失败：{error}"))?;

    // Windows 上此时安装器已接管；显式允许退出，避免隐藏到托盘的拦截逻辑
    // 把进程留在后台导致安装器无法覆盖文件。
    main_window::allow_exit();
    logging::info("update installed, exiting for installer");
    app.exit(0);
    Ok(())
}

/// 在托盘 tooltip 上标注有可用更新，让用户知道该去点「检查更新」。
pub fn update_tray_hint<R: Runtime>(app: &AppHandle<R>, version: Option<&str>) {
    let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) else {
        return;
    };
    let tooltip = match version {
        Some(version) => format!("Melodex - 有新版本 {version}，点托盘查看"),
        None => "Melodex".to_string(),
    };
    if let Err(error) = tray.set_tooltip(Some(&tooltip)) {
        logging::warn(format!("set tray tooltip failed: {error}"));
    }
}

/// 用户从托盘主动点「检查更新」。
///
/// 与后台静默检查的区别：这里会在发现新版本时**先让用户确认**再下载安装，
/// 避免播放中被打断。确认走本地对话框（不依赖远程页面，故不需要额外 IPC 权限）。
pub fn interactive_check<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&handle).await {
            Ok(None) => {
                logging::info("interactive update check: already latest");
                dialog::message(&handle, "检查更新", "当前已是最新版本。");
            }
            Ok(Some(version)) => {
                logging::info(format!("interactive update check: {version} available"));
                let confirmed = dialog::confirm(
                    &handle,
                    "发现新版本",
                    &format!(
                        "检测到 Melodex {version}。\n\n下载安装会关闭当前播放并重启客户端。现在更新吗？"
                    ),
                );
                if !confirmed {
                    logging::info("user declined update");
                    return;
                }
                if let Err(error) = download_and_install(&handle).await {
                    logging::error(format!("update failed: {error}"));
                    dialog::message(&handle, "更新失败", &error);
                }
            }
            Err(error) => {
                logging::warn(format!("interactive update check failed: {error}"));
                dialog::message(&handle, "检查更新失败", &error);
            }
        }
    });
}

/// 极简原生对话框封装。
///
/// 刻意不引入 `tauri-plugin-dialog`：本壳只需要两个最简单的系统提示，
/// 自己调平台 API 反而让依赖更少、权限面更干净。
mod dialog {
    use tauri::{AppHandle, Runtime};

    // Windows 走原生 MessageBox；其他平台只写日志，故条件导入避免 unused 警告。
    #[cfg(not(target_os = "windows"))]
    use crate::logging;

    #[cfg(target_os = "windows")]
    pub fn message<R: Runtime>(_app: &AppHandle<R>, title: &str, body: &str) {
        windows_message(title, body, false);
    }

    #[cfg(target_os = "windows")]
    pub fn confirm<R: Runtime>(_app: &AppHandle<R>, title: &str, body: &str) -> bool {
        windows_message(title, body, true)
    }

    #[cfg(not(target_os = "windows"))]
    pub fn message<R: Runtime>(_app: &AppHandle<R>, title: &str, body: &str) {
        logging::info(format!("dialog [{title}] {body}"));
    }

    #[cfg(not(target_os = "windows"))]
    pub fn confirm<R: Runtime>(_app: &AppHandle<R>, title: &str, body: &str) -> bool {
        // 非 Windows 平台暂不做交互确认：默认拒绝，避免无提示地重启。
        logging::info(format!("dialog (auto-declined) [{title}] {body}"));
        false
    }

    #[cfg(target_os = "windows")]
    fn windows_message(title: &str, body: &str, confirm: bool) -> bool {
        use std::ffi::OsStr;
        use std::iter::once;
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                hwnd: *mut std::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                utype: u32,
            ) -> i32;
        }

        const MB_OK: u32 = 0x0000_0000;
        const MB_YESNO: u32 = 0x0000_0004;
        const MB_ICONINFORMATION: u32 = 0x0000_0040;
        const MB_ICONWARNING: u32 = 0x0000_0030;
        const MB_SETFOREGROUND: u32 = 0x0001_0000;
        const IDYES: i32 = 6;

        let wide = |value: &str| -> Vec<u16> {
            OsStr::new(value)
                .encode_wide()
                .chain(once(0))
                .collect::<Vec<u16>>()
        };
        let text = wide(body);
        let caption = wide(title);
        let style = if confirm {
            MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND
        } else {
            MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND
        };

        // SAFETY: 两个宽字符串都在调用期间存活；空指针 hwnd 表示无父窗口。
        let answer =
            unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), style) };
        confirm && answer == IDYES
    }
}
