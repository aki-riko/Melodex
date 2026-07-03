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
