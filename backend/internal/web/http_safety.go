package web

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// maxBufferedAudioBytes 限制"必须整段读进内存再解密"的音频(soda)单次缓冲上限。
// 一首无损单曲一般 <50MB,取 100MB 留足余量;× 并发数即峰值内存,故不宜设太大。
const maxBufferedAudioBytes int64 = 100 * 1024 * 1024

// serverWriteTimeout 是普通接口的写超时,防慢速读取客户端(Slow Read)长期占用写连接。
// 音频流式接口在写响应前调用 clearWriteDeadline 解除此限制(流时长不可预期)。
const serverWriteTimeout = 30 * time.Second

// clearWriteDeadline 在流式写响应前清除底层连接的写截止时间,使音频流不受
// server.WriteTimeout(serverWriteTimeout)约束。gin 的 ResponseWriter 实现了
// Unwrap(),ResponseController 可透传到底层 net.Conn。SetWriteDeadline 不被支持
// 或失败时静默降级(如测试用 httptest.Recorder),不影响非流式路径。
func clearWriteDeadline(c *gin.Context) {
	if c == nil || c.Writer == nil {
		return
	}
	rc := http.NewResponseController(c.Writer)
	// time.Time{}(零值)表示"永不超时",覆盖全局 WriteTimeout。
	_ = rc.SetWriteDeadline(time.Time{})
}

// searchWriteTimeout 是"要等上游"接口(多源搜索/验活/歌词)的写超时上界。
//
// 这类接口天生要等:多源搜索的时间预算就有 60s(MUSIC_DL_SEARCH_SOURCE_BUDGET),
// 验活单首也可能跑十几秒,而全局 serverWriteTimeout 只有 30s。后果是 handler 在
// 预算到点准备写响应时,写截止时间早已过期 → 连接被关闭 → 客户端拿到 0 字节、
// 反向代理报 502。实测:8 个源里 7 个已返回(含 QQ),客户端仍然只看到 61 秒后
// 的 502,因为响应根本写不出去。
//
// 这里给一个明确上界而不是像音频流那样完全不限制:既让慢搜索能送达,又不至于
// 让慢速读取的客户端长期占住连接。
const searchWriteTimeout = 3 * time.Minute

// extendWriteDeadline 把当前连接的写截止时间推到 timeout 之后。与 clearWriteDeadline
// 的区别是保留了上界,供"要等上游但终会结束"的接口使用;不支持 SetWriteDeadline 的
// writer 静默降级。
func extendWriteDeadline(c *gin.Context, timeout time.Duration) {
	if c == nil || c.Writer == nil || timeout <= 0 {
		return
	}
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetWriteDeadline(time.Now().Add(timeout))
}

var outboundStreamingHTTPClient = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
	},
}

func limitRequestBody(c *gin.Context, maxBytes int64) {
	if c == nil || c.Request == nil || c.Request.Body == nil {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
}

func isRequestBodyTooLarge(err error) bool {
	if err == nil {
		return false
	}
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return true
	}
	return strings.Contains(err.Error(), "http: request body too large")
}

func readLimitedBody(r io.Reader, maxBytes int64) ([]byte, error) {
	limited := &io.LimitedReader{R: r, N: maxBytes + 1}
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("response body exceeds %d bytes", maxBytes)
	}
	return data, nil
}
