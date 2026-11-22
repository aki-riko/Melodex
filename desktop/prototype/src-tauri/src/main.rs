#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 阶段 0 原型：只做验证，不承载任何产品逻辑。
//! 验证完整个 desktop/prototype 目录可直接删除。
//!
//! 取证通道（双保险）：
//! 1. 页面把探测结果 POST 到 127.0.0.1 上的临时回环端口；
//! 2. Rust 侧同时写 stderr（无缓冲）与日志文件，避免管道缓冲导致证据丢失。

use std::{
    fs::OpenOptions,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

const PROBE_LABEL: &str = "probe";
const SITE_LABEL: &str = "site";
const REPORT_PORT: u16 = 47821;
const LOG_FILE: &str = r"D:\其他项目\Melodex\desktop\prototype\prototype.log";

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

fn log(message: &str) {
    let line = format!("[{}] {}\n", stamp(), message);
    // stderr 无缓冲，即使 stdout 管道被缓冲也不丢证据。
    eprint!("{line}");
    let lock = LOG_LOCK.get_or_init(|| Mutex::new(()));
    if let Ok(_guard) = lock.lock() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(LOG_FILE) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// 极简回环上报端点：只接受 POST /report，读完整 body 后打进日志文件，
/// 并回应 CORS 放行，使远程 origin 的页面能跨域 POST 进来。
fn spawn_report_listener() {
    thread::spawn(|| {
        let listener = match TcpListener::bind(("127.0.0.1", REPORT_PORT)) {
            Ok(listener) => listener,
            Err(error) => {
                log(&format!("REPORT listener bind failed: {error}"));
                return;
            }
        };
        log(&format!("REPORT listener on 127.0.0.1:{REPORT_PORT}"));

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    thread::spawn(move || handle_report(stream));
                }
                Err(error) => log(&format!("REPORT accept failed: {error}")),
            }
        }
    });
}

fn handle_report(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = [0u8; 65536];
    let mut request = Vec::new();
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                request.extend_from_slice(&buffer[..n]);
                if let Some(head_end) = find_subslice(&request, b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..head_end]).to_string();
                    let content_length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if request.len() >= head_end + 4 + content_length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }

    let head_end = find_subslice(&request, b"\r\n\r\n").unwrap_or(0);
    let head = String::from_utf8_lossy(&request[..head_end]).to_string();
    let request_line = head.lines().next().unwrap_or_default().to_string();
    let body = if request.len() > head_end + 4 {
        String::from_utf8_lossy(&request[head_end + 4..]).to_string()
    } else {
        String::new()
    };

    // OPTIONS 预检不刷屏，只记一行。
    if request_line.starts_with("OPTIONS") {
        log("REPORT preflight OPTIONS");
    } else {
        log(&format!("REPORT {request_line}"));
        if !body.trim().is_empty() {
            let clipped: String = body.chars().take(4000).collect();
            log(&format!("REPORT_BODY {clipped}"));
        }
    }

    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: 2\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: content-type\r\n\
         Connection: close\r\n\r\n{{}}"
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn main() {
    // 清空上一轮日志，便于本轮取证只包含本次运行。
    let _ = std::fs::remove_file(LOG_FILE);
    spawn_report_listener();
    log("prototype starting");

    // wry 默认会传这些 --disable-features，显式写出避免覆盖后重新打开浏览器 UI。
    // 追加 autoplay 策略仅为验证 R1：确认「能播放」前提下 WebView2 是否建立 SMTC 会话。
    const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --autoplay-policy=no-user-gesture-required";

    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, PROBE_LABEL, WebviewUrl::default())
                .title("Melodex Shell Prototype - Probe")
                .inner_size(560.0, 940.0)
                .position(20.0, 30.0)
                .additional_browser_args(BROWSER_ARGS)
                .build()?;

            let raw = std::env::var("MELODEX_PROTOTYPE_SITE")
                .unwrap_or_else(|_| "https://music.9li.life/".to_string());
            let parsed: Url = raw
                .parse()
                .map_err(|error| format!("invalid MELODEX_PROTOTYPE_SITE {raw}: {error}"))?;
            log(&format!("site window loading {parsed}"));

            WebviewWindowBuilder::new(app, SITE_LABEL, WebviewUrl::External(parsed))
                .title("Melodex Shell Prototype - Site")
                .inner_size(1200.0, 940.0)
                .position(600.0, 30.0)
                .on_navigation(|url| {
                    log(&format!("NAV {}", url.as_str()));
                    true
                })
                .on_page_load(move |window, payload| {
                    log(&format!("PAGE_LOAD {} {:?}", payload.url(), payload.event()));
                    let _ = window.eval(&sw_probe_js());
                })
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("prototype shell failed to run");
}

/// 注入到远程站点的诊断脚本。
/// 只读：不改 DOM、不写存储、不上传任何站点数据，只把环境与 SW 状态发回本地回环端点。
fn sw_probe_js() -> String {
    format!(
        r#"(function(){{
  if (window.__melodexSwProbeDone) return;
  window.__melodexSwProbeDone = true;
  var out = {{
    kind: 'sw',
    href: location.href,
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasMediaSession: 'mediaSession' in navigator,
    hasMediaMetadata: 'MediaMetadata' in window,
    ua: navigator.userAgent,
    controller: (navigator.serviceWorker && navigator.serviceWorker.controller) ? navigator.serviceWorker.controller.scriptURL : null
  }};
  function post(payload) {{
    try {{
      fetch('http://127.0.0.1:{port}/report', {{
        method: 'POST',
        headers: {{ 'content-type': 'application/json' }},
        body: JSON.stringify(payload)
      }}).catch(function(){{}});
    }} catch (e) {{}}
  }}
  if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {{
    navigator.serviceWorker.getRegistrations().then(function(regs){{
      out.registrations = regs.map(function(r){{ return r.scope; }});
      post(out);
    }}).catch(function(e){{
      out.registrationsError = String(e);
      post(out);
    }});
  }} else {{
    post(out);
  }}
}})();"#,
        port = REPORT_PORT
    )
}
