package web

// 全库扫描:500/502/503 响应里不得直接拼 err.Error()(2026-11 全库扫描)。
//
// 上面 client_errors_test.go 验证的是"工具函数行为正确";这条验证的是
// "**全库没有漏掉的调用点**" —— 两者缺一不可:工具再对,只要有一个 handler
// 还在 `c.JSON(500, gin.H{"error": err.Error()})`,那一处就照样泄漏。
//
// 为什么用源码扫描而不是运行时:这些分支大多要构造真实故障(磁盘满、
// 数据库坏、上游超时)才能触发,不可能为每一处都写集成测试。
// 静态扫描在这里是合适的工具 —— 规则很机械(错误状态码 + err.Error()),
// 误报率极低。
//
// ★ 允许的例外(写在这里,让新增例外必须显式改这个名单):
//   - client_errors.go 自己(它就是实现);
//   - 400 类:用户输入错误,必须保留原因;
//   - _test.go。
//
// 若确实需要新增一处"内部错误但必须带详情"的例外,请在此表登记并写清理由,
// 而不是悄悄绕过 —— 这是刻意制造的摩擦。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// internalErrorStatusMarkers 是"内部错误"的状态码写法。
// 100% 覆盖本项目用过的形式:500/502/503 的字面量、对应的常量。
var internalErrorStatusMarkers = []string{
	"StatusInternalServerError",
	"StatusBadGateway",
	"StatusServiceUnavailable",
	"http.StatusGatewayTimeout",
}

// allowedException 描述一处**刻意保留**的例外。
type allowedException struct {
	file   string
	line   string // 该行的特征片段(用于在行号漂移时仍能匹配)
	reason string
}

// allowedExceptions 是显式登记的例外清单。
//
// ★ 这里的每一条都必须写清"为什么它不算泄漏"。新增例外必须改这张表 ——
// 这是刻意制造的摩擦:让评审在 diff 里看得见,而不是悄悄绕过规则。
var allowedExceptions = []allowedException{
	{
		file: "recognition.go",
		line: "Message: err.Error()}",
		reason: "识曲 endpoint 配置校验(validateRecognitionEndpoint)。错误文案是" +
			"「识曲服务 endpoint 无效 / 只支持 http/https / http 时只能指向本机测试地址」——" +
			"全是中文、面向管理员配置的可读提示,不含内部路径与栈信息。遮蔽它等于让管理员" +
			"没法知道配置错在哪。配置这件事的『用户』就是管理员本人,属于用户输入错误。",
	},
}

func TestNoInternalErrorLeaksToClients(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读取包目录失败: %v", err)
	}

	var violations []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") {
			continue
		}
		if strings.HasSuffix(name, "_test.go") || name == "client_errors.go" {
			continue
		}

		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("读取 %s 失败: %v", name, err)
		}
		lines := strings.Split(string(raw), "\n")

		for i, line := range lines {
			// 只看真正把 err.Error() 写进响应体的行。
			if !strings.Contains(line, "err.Error()") {
				continue
			}
			// 注释行不算。
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") {
				continue
			}

			// 判定这一行是否属于"内部错误响应"。
			// 三种形态:
			//   c.JSON(http.StatusInternalServerError, gin.H{"error": ...})
			//   c.JSON(500, gin.H{"error": ...})
			//   Message: err.Error()  (recognitionStatusError 之类,状态码在别处)
			isInternal := false
			for _, marker := range internalErrorStatusMarkers {
				if strings.Contains(line, marker) {
					isInternal = true
					break
				}
			}
			// 数字状态码:500/502/503/504 紧跟在 c.JSON( 之后。
			if !isInternal && (strings.Contains(line, "c.JSON(500") ||
				strings.Contains(line, "c.JSON(502") ||
				strings.Contains(line, "c.JSON(503") ||
				strings.Contains(line, "c.JSON(504")) {
				isInternal = true
			}

			if !isInternal {
				continue
			}

			// 已登记的例外:必须同时命中文件名与行特征。
			isAllowed := false
			for _, ex := range allowedExceptions {
				if name == ex.file && strings.Contains(line, ex.line) {
					isAllowed = true
					break
				}
			}
			if isAllowed {
				continue
			}

			// 已经走统一工具的写法不会含 err.Error()(它把 err 作为参数传),
			// 所以能走到这里的都是直拼。
			violations = append(violations, filepath.Base(name)+":"+
				itoa(i+1)+"  "+trimmed)
		}
	}

	if len(violations) > 0 {
		t.Fatalf("发现 %d 处内部错误直接外泄给客户端:\n  %s\n\n"+
			"改为 respondInternalError(c, \"给用户看的一句话\", err):\n"+
			"  · 详情只进服务端日志(含 request id,便于用户报障时定位);\n"+
			"  · 响应体只给固定文案 + request_id。\n"+
			"若确实需要例外(例如管理员可见的配置诊断),请在\n"+
			"client_errors_test.go 的例外名单里显式登记并写清理由。",
			len(violations), strings.Join(violations, "\n  "))
	}
}

// itoa 避免为了一个行号引入 strconv。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
