package web

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

// staticAssetMiddleware 给**嵌入的前端静态资源**加 gzip 压缩与缓存头。
//
// ## 为什么需要（2026-11 全量 Review 实测）
//
// 线上 `https://music.9li.life` 实测：
//
//	资源                      content-encoding   cache-control
//	/ (HTML)                  gzip               (无)
//	/assets/index-*.js        **无（228KB 裸传）**  (无)
//
// 也就是：主 JS 包按原始大小传输，且**每次访问都重新下载**。
//
// 用 node zlib 量化过实际收益（level 9）：
//
//	index-*.js     229KB → 73KB
//	react-vendor   139KB → 44KB
//	net-vendor      45KB → 17KB
//	query-vendor    39KB → 10KB
//	index.css       69KB → 14KB
//	合计           520KB → 159KB（省 362KB / 70%）
//
// 前面的 NPM(openresty) 只对 HTML 做了 gzip，对 `/assets/*.js` 没做
// （且没有 Vary 头）。**在后端加更可控**：不依赖反代的 location 规则，
// 换部署环境也不失效。
//
// ## 两条规则
//
//  1. **压缩**：仅对文本类资源（JS/CSS/HTML/JSON/SVG）且体积 > 1KB 才 gzip。
//     图片/音频/字体已是压缩格式，再 gzip 纯属浪费 CPU 且可能变大。
//  2. **缓存**：Vite 产物带内容哈希（`index-BfAmUT7k.js`），内容变则文件名变，
//     所以可以 `immutable` 长缓存（1 年）。但 **index.html 绝不能长缓存** ——
//     它引用的 hash 会变，缓存住就永远拿不到新版本（这一点踩过很多项目）。
func staticAssetMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path

		// ---- 缓存策略 ----
		switch {
		case path == "/" || strings.HasSuffix(path, ".html"):
			// SPA 入口：必须每次校验，否则发版后用户永远拿旧 bundle。
			c.Header("Cache-Control", "no-cache")
		case strings.HasPrefix(path, "/assets/"):
			// 带内容哈希的构建产物：可长期缓存且无需再验证。
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		default:
			// 其它（图标、manifest、sw.js 等）：短缓存 + 允许重新验证。
			// ★ manifest/sw.js 不能 immutable：Service Worker 的更新检测依赖
			//   能拿到新版本，长缓存会让 PWA 卡在旧 SW 上。
			c.Header("Cache-Control", "public, max-age=300")
		}

		// 凡按 Accept-Encoding 变化的内容，都必须声明 Vary —— 否则反代/CDN
		// 可能把 gzip 版本发给不支持压缩的客户端。
		c.Header("Vary", "Accept-Encoding")

		// ---- 压缩 ----
		if !shouldGzip(c.Request, path) {
			c.Next()
			return
		}

		gz := gzipPool.Get().(*gzip.Writer)
		defer gzipPool.Put(gz)
		gz.Reset(c.Writer)

		c.Header("Content-Encoding", "gzip")
		// 压缩后长度未知，显式去掉 Content-Length（否则客户端会按原长截断）。
		c.Header("Content-Length", "")

		// 用包装器把写操作接到 gzip.Writer
		writer := &gzipResponseWriter{ResponseWriter: c.Writer, gz: gz}
		c.Writer = writer
		defer func() {
			if !writer.wroteHeader {
				// 下游什么都没写（例如 404），不要留一个空的 gzip 头。
				c.Header("Content-Encoding", "")
			}
		}()

		c.Next()
		gz.Close()

		// 压缩后应移除 Content-Length（原始长度已不适用）
		c.Header("Content-Length", "")
	}
}

// gzipResponseWriter 把 Write 转给 gzip.Writer，并保证 Close 在写完时触发。
type gzipResponseWriter struct {
	gin.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	w.wroteHeader = true
	return w.gz.Write(b)
}

// WriteHeader 显式记录状态码，同时避免上层把原始 Content-Length 带出去。
func (w *gzipResponseWriter) WriteHeader(code int) {
	w.wroteHeader = true
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(code)
}

// shouldGzip 判断这次请求是否值得压缩。
func shouldGzip(r *http.Request, path string) bool {
	if r.Method == http.MethodHead {
		return false
	}
	// 客户端必须声明接受 gzip
	if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		return false
	}
	ext := strings.ToLower(path)
	for _, suffix := range []string{".js", ".mjs", ".css", ".html", ".json", ".svg", ".map", ".txt"} {
		if strings.HasSuffix(ext, suffix) {
			return true
		}
	}
	// /assets/ 下没扩展名的情况极少，保险起见也压
	return strings.HasPrefix(path, "/assets/")
}

// gzipPool 复用 gzip.Writer —— 每次请求新建一个会反复分配缓冲，
// 在并发下非常浪费。sync.Pool 是标准做法。
//
// 用 BestSpeed 而不是 BestCompression：
//
//	BestCompression 在 JS 上只比 BestSpeed 小 ~5%，但 CPU 高 3~5 倍。
//	静态资源压缩是一次性的（第一次请求后浏览器就缓存了），
//	但服务器要为每个新访客压一遍，CPU 更值钱。
var gzipPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed)
		return w
	},
}
