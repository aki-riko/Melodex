package web

import (
	"io/fs"
	"strings"
)

// fsSubForTest 返回嵌入的前端产物子文件系统（测试辅助）。
// 单独放一个文件，避免静态测试与生产代码混在一起。
func fsSubForTest() (fs.FS, error) {
	return fs.Sub(frontendDistFS, "frontend_dist")
}

// findAssetForTest 在嵌入产物里找一个指定后缀的资源路径（如 .js）。
// 返回空串表示没有。用于测试「真实存在的资源能被正确压缩」。
func findAssetForTest(sub fs.FS, suffix string) string {
	var found string
	_ = fs.WalkDir(sub, "assets", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.HasSuffix(p, suffix) {
			found = p
			return fs.SkipAll
		}
		return nil
	})
	return found
}
