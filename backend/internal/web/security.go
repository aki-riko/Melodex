package web

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// isPublicHTTPURL 校验目标 URL 是否为安全的对外 http(s) 地址,用于防 SSRF。
// 拒绝:非 http(s) 协议、无主机、解析到内网/环回/链路本地/保留地址的目标
// (如 127.0.0.1、10.x、192.168.x、169.254.169.254 云元数据等)。
func isPublicHTTPURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("无法解析 URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("仅允许 http/https")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("缺少主机名")
	}

	// 解析主机的所有 IP(含 DNS 解析),任一落在内网/保留段即拒绝,
	// 防止用域名指向内网或借 DNS rebinding 绕过。
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		// 解析不出 IP:若 host 本身是 IP 字面量则直接判,否则拒绝
		if ip := net.ParseIP(host); ip != nil {
			ips = []net.IP{ip}
		} else {
			return fmt.Errorf("无法解析主机")
		}
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return fmt.Errorf("目标地址不被允许")
		}
	}
	return nil
}

// isBlockedIP 判断 IP 是否落在内网/环回/链路本地/唯一本地/未指定等不应被代理访问的范围。
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	// 显式拦截云元数据地址(IsLinkLocal 已覆盖 169.254.0.0/16,这里冗余兜底)
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
	}
	return false
}
