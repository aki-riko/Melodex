package web

import (
	"sync"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// backgroundWarmers 登记「异步预热」类后台任务，供**测试**等待它们退出。
//
// ## 为什么需要（2026-11 全量 Review，`go test -race` 实测）
//
// `warmQualityCache` 起了一个后台 goroutine 去逐首探测音质并写缓存。
// 它本身是**产品的正确设计**（不能让探测阻塞请求），但没有任何句柄可以等它结束。
//
// 后果：测试结束时（`t.Cleanup` → `resetCollectionStateForTest`）
// 直接 `qualityWarmInFlight = sync.Map{}` 把包级变量整个替换掉，
// 而那个后台 goroutine 可能**正好还在** LoadOrStore/Delete 上 —— 数据竞争：
//
//	WARNING: DATA RACE
//	Write at ... by resetCollectionStateForTest()  (collection_contract_support_test.go:28)
//	Previous read at ... qualityWarmInFlight.LoadOrStore
//
// 这不只是测试噪音：`go test -race` 直接 FAIL，
// 会让「数据竞争」这类真正危险的并发 bug 淹没在噪声里。
//
// ## 做法
//
// 用一个包级 WaitGroup 登记所有后台预热任务；测试在重置全局状态前
// 先 `waitBackgroundWarmers()`。生产路径不调用等待（多一些登记开销可忽略）。
//
// ★ 注意 WaitGroup 的经典坑：不能并发 Add 与 Wait。
// 这里由测试保证「先不再发起新预热，再等待」，见 waitBackgroundWarmers 的注释。
var backgroundWarmers sync.WaitGroup

// trackBackgroundWarmer 登记一个后台任务。返回的函数用于在任务结束时注销。
func trackBackgroundWarmer() func() {
	backgroundWarmers.Add(1)
	return backgroundWarmers.Done
}

// waitBackgroundWarmers 等待所有登记的后台预热任务退出。
//
// 仅用于测试。调用前必须确保不会再发起新的预热（否则 WaitGroup 会 panic）。
func waitBackgroundWarmers() {
	backgroundWarmers.Wait()
}

// inspectQualityCachedSafely 包装 inspectSongQualityCached，
// 在后台 goroutine 里承受「DB 已被测试关闭」的情况。
//
// 为什么需要：测试清理顺序是
//
//	① closeCollectionDBForTest()   ← 关掉 db
//	② reset 各种包级缓存
//
// 而后台预热可能在 ① 之后仍在跑。此时 inspectSongQualityCached 会拿到
// 一个已关闭的 *gorm.DB 并可能 panic。生产环境不会走到这里（库不会中途关），
// 但测试里必须兜住，否则表现为偶发的 `FAIL` 且看不到具体用例名。
func inspectQualityCachedSafely(song model.Track) {
	defer func() {
		// 后台预热失败不影响任何用户可见行为（下一次请求会重新探测），
		// 所以这里吞掉 panic 是安全的。
		_ = recover()
	}()
	if db == nil {
		return
	}
	inspectSongQualityCached(song, song.Duration)
}
