package web

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// 轻量 per-IP 滑动窗口限流。用于公开且会放大到上游的接口(搜索),
// 防匿名/单用户高频调用把本服务变成对上游的放大代理或耗尽出网。
type rateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]int64 // ip -> 最近请求的纳秒时间戳
	limit  int
	window time.Duration
	lastGC time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{hits: make(map[string][]int64), limit: limit, window: window}
}

// allow 返回该 ip 是否在窗口内未超过 limit 次。
func (r *rateLimiter) allow(ip string) bool {
	now := time.Now()
	cutoff := now.Add(-r.window).UnixNano()
	r.mu.Lock()
	defer r.mu.Unlock()

	// 周期性清理空闲 IP,防 map 无限增长。
	if now.Sub(r.lastGC) > 5*time.Minute {
		for k, ts := range r.hits {
			if len(ts) == 0 || ts[len(ts)-1] < cutoff {
				delete(r.hits, k)
			}
		}
		r.lastGC = now
	}

	ts := r.hits[ip]
	kept := ts[:0]
	for _, t := range ts {
		if t >= cutoff {
			kept = append(kept, t)
		}
	}
	if len(kept) >= r.limit {
		r.hits[ip] = kept
		return false
	}
	r.hits[ip] = append(kept, now.UnixNano())
	return true
}

// searchRateLimiter:公开搜索接口的 per-IP 限流(30 次/分钟)。
var searchRateLimiter = newRateLimiter(30, time.Minute)

// rateLimitMiddleware 超限返回 429。
func rateLimitMiddleware(rl *rateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !rl.allow(c.ClientIP()) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁,请稍后再试"})
			return
		}
		c.Next()
	}
}
