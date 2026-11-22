//! Melodex 站点地址解析与导航白名单。
//!
//! 规则（与既有 desktop/src-tauri 的 `normalize_service_url` 保持一致的安全标准）：
//! - 只接受 https；仅回环地址允许 http（本机开发）。
//! - 不允许内嵌账号密码。
//! - 路径统一归一到 `/`。
//!
//! 导航白名单：主窗口只允许停在站点同源内，外加登录网关（Authentik）所在源。
//! 任何其他外链一律交给系统浏览器打开，避免远程页面把 WebView 变成任意网页宿主。

use reqwest::Url;
use std::net::IpAddr;

/// 默认站点。构建时可用 `MELODEX_SHELL_SITE` 环境变量覆盖（见 build.rs 之外运行时读取）。
pub const DEFAULT_SITE: &str = "https://music.9li.life/";

pub fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => false,
    }
}

/// 解析并校验站点根地址。
pub fn normalize_site_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("请配置 Melodex 站点地址".to_string());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = Url::parse(&candidate).map_err(|error| format!("站点地址格式不正确：{error}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("站点地址只支持 HTTPS；本机调试可使用 HTTP".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("站点地址不能包含账号或密码".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "站点地址缺少主机名".to_string())?;
    if url.scheme() == "http" && !is_loopback_host(host) {
        return Err("非本机站点必须使用 HTTPS".to_string());
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// 运行时确定站点：优先环境变量，其次编译期默认值。
pub fn resolve_site() -> Result<Url, String> {
    let raw = std::env::var("MELODEX_SHELL_SITE").unwrap_or_else(|_| DEFAULT_SITE.to_string());
    normalize_site_url(&raw)
}

/// 同一 origin 判定（协议 + 主机 + 端口）。
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// 导航是否允许留在 WebView 内。
///
/// 允许：站点同源、登录网关同源。
/// 禁止：其余一切（交由系统浏览器）。
pub fn navigation_allowed(url: &Url, site: &Url, login_origin: Option<&Url>) -> bool {
    // 自绘页面（tauri:// 等）由壳自身处理，放行。
    if url.scheme() == "tauri" || url.scheme() == "about" || url.scheme() == "data" {
        return true;
    }
    if same_origin(url, site) {
        return true;
    }
    match login_origin {
        Some(origin) => same_origin(url, origin),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_https_site_root() {
        let url = normalize_site_url("music.example.test/some/path?ignored=1").expect("url");
        assert_eq!(url.as_str(), "https://music.example.test/");
    }

    #[test]
    fn permits_loopback_http() {
        let url = normalize_site_url("http://127.0.0.1:8329/music").expect("url");
        assert_eq!(url.as_str(), "http://127.0.0.1:8329/");
    }

    #[test]
    fn rejects_cleartext_remote() {
        let error = normalize_site_url("http://music.example.test").expect_err("must reject");
        assert!(error.contains("必须使用 HTTPS"));
    }

    #[test]
    fn rejects_embedded_credentials() {
        let error =
            normalize_site_url("https://user:pass@music.example.test").expect_err("must reject");
        assert!(error.contains("不能包含账号或密码"));
    }

    #[test]
    fn rejects_empty() {
        assert!(normalize_site_url("   ").is_err());
    }

    #[test]
    fn allows_same_origin_navigation() {
        let site = normalize_site_url("https://music.9li.life/").expect("site");
        let target = Url::parse("https://music.9li.life/#myplaylist").expect("target");
        assert!(navigation_allowed(&target, &site, None));
    }

    #[test]
    fn allows_login_gateway_origin() {
        let site = normalize_site_url("https://music.9li.life/").expect("site");
        let login = Url::parse("https://auth.9li.life/").expect("login");
        let target = Url::parse("https://auth.9li.life/if/flow/default/").expect("target");
        assert!(navigation_allowed(&target, &site, Some(&login)));
    }

    #[test]
    fn blocks_foreign_origin() {
        let site = normalize_site_url("https://music.9li.life/").expect("site");
        let target = Url::parse("https://evil.example/steal").expect("target");
        assert!(!navigation_allowed(&target, &site, None));
    }

    #[test]
    fn blocks_foreign_origin_even_with_login_gateway() {
        let site = normalize_site_url("https://music.9li.life/").expect("site");
        let login = Url::parse("https://auth.9li.life/").expect("login");
        let target = Url::parse("https://evil.example/steal").expect("target");
        assert!(!navigation_allowed(&target, &site, Some(&login)));
    }

    #[test]
    fn blocks_downgrade_to_http() {
        let site = normalize_site_url("https://music.9li.life/").expect("site");
        let target = Url::parse("http://music.9li.life/").expect("target");
        assert!(!navigation_allowed(&target, &site, None));
    }

    #[test]
    fn allows_internal_schemes() {
        let site = normalize_site_url("https://music.9li.life/").expect("site");
        for raw in ["tauri://localhost/index.html", "about:blank"] {
            let target = Url::parse(raw).expect("target");
            assert!(navigation_allowed(&target, &site, None), "{raw}");
        }
    }
}
