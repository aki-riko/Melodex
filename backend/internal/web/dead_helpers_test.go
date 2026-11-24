package web

// 孤儿函数的防复活门禁(2026-11 全库扫描)。
//
// 背景:下面三个函数曾长期烂在库里 —— 名字像公开 API、实现完整、能编译,
// 但**唯一引用就是定义本身**(全库 grep 计数 = 1):
//   · uniqueLocalMusicPath(dir, filename)      —— local_media_files.go
//   · validateLocalCollectionTarget(collection) —— local_music_routes.go
//   · StartWithOptions(port, options)          —— web_runtime.go
//
// 为什么必须删:它们给后来者(和 AI)制造错误的架构印象。看到
// `StartWithOptions(port, options)` 会以为这是受支持的编程式启动方式,
// 于是围绕它写代码,而实际上入口是 StartDesktop / runWebServer。
//
// ★ `deleteUser` **没有删** —— 虽然也是非导出函数,但 users_test.go 在用它
//   验证「不能删除最后一个管理员」这条安全约束,那是活代码。
//   这条注释留在这里,防止下次扫描又把 deleteUser 当死代码删掉。
//
// 为什么写测试而不是只留注释:注释不会失败。若将来有人重新加回同名函数
// (可能是复制粘贴旧代码),这条会红并指名道姓。

import (
	"os"
	"strings"
	"testing"
)

// deletedOrphans 是已删除的孤儿函数名 → 删除理由与替代路径。
var deletedOrphans = map[string]string{
	"uniqueLocalMusicPath": "路径去重由调用点显式实现;通用工具没有真实调用方",
	"validateLocalCollectionTarget": "只读性检查由各写操作入口的 " +
		"loadOwnedCollection + isImported 完成(读时 404 比 500 语义更准确)",
	"StartWithOptions": "对外入口是 StartDesktop,内部实现是 runWebServer",
}

// TestOrphanHelpersStayDeleted 扫描本包源码,确认这些名字没有被重新引入。
func TestOrphanHelpersStayDeleted(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读取包目录失败: %v", err)
	}

	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") {
			continue
		}
		// 本文件自身会提到这些名字(就在上面的表里),跳过。
		if name == "dead_helpers_test.go" {
			continue
		}

		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("读取 %s 失败: %v", name, err)
		}

		for fn, reason := range deletedOrphans {
			// 只认真正的声明与调用形态,避免命中注释里的提及。
			decl := "func " + fn + "("
			if strings.Contains(string(raw), decl) {
				t.Fatalf("%s 里重新出现了已删除的孤儿函数 %s(...)\n"+
					"当初删除的理由:%s\n"+
					"若确实需要这个能力,请显式实现并接入真实调用方 + 补测试,\n"+
					"而不是复活一个没人用的通用工具。", name, fn, reason)
			}
		}
	}

	// deleteUser 必须**仍然存在** —— 它有活测试在用,不能被当成死代码删掉。
	usersRaw, err := os.ReadFile("users.go")
	if err != nil {
		t.Fatalf("读取 users.go 失败: %v", err)
	}
	if !strings.Contains(string(usersRaw), "func deleteUser(") {
		t.Fatalf("deleteUser 被误删了 —— users_test.go 用它验证" +
			"「不能删除最后一个管理员」这条安全约束,是活代码")
	}
}
