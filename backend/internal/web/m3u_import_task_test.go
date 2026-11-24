package web

// m3u 导入改为"提交即返回 + 轮询进度"后的契约(2026-11 全库扫描, P2-13 方案 C)。
//
// 改前的真实缺陷(已核实,不是推测):
//   · 条目上限 1000,每条一次全源搜索(主力源实测 1~2 秒),同步阻塞;
//   · 前端 axios 超时 600 秒;
//   · 而 `db.Create(&coll)` 在循环**之前**执行 —— 所以 600 秒后前端报"导入失败",
//     但歌单已建好、歌正在一首首加。用户刷新后看到歌单出现,以为软件有鬼。
//
// 这里测的是**新契约的边界**,不是搜索匹配的正确性(那依赖外网,不该进单测):
//   ① 提交立刻返回 task_id,不阻塞;
//   ② 任务进度可查、字段自洽(total/processed/matched/skipped/percent);
//   ③ 跨用户查不到他人任务(返回 nil,handler 回 404);
//   ④ 同一用户已有进行中任务时不重复启动;
//   ⑤ 取消能把状态打成 cancelled,且重复取消不 panic。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// resetM3UImportTaskStore 清空全局任务表,避免用例相互污染。
func resetM3UImportTaskStore(t *testing.T) {
	t.Helper()
	m3uImportTaskStore.Lock()
	m3uImportTaskStore.tasks = map[string]*m3uImportTask{}
	m3uImportTaskStore.byUser = map[uint]string{}
	m3uImportTaskStore.Unlock()
	t.Cleanup(func() {
		m3uImportTaskStore.Lock()
		m3uImportTaskStore.tasks = map[string]*m3uImportTask{}
		m3uImportTaskStore.byUser = map[uint]string{}
		m3uImportTaskStore.Unlock()
	})
}

func TestM3UImportTaskLifecycle(t *testing.T) {
	resetM3UImportTaskStore(t)

	task, existing := newM3UImportTask(7, "导入歌单", 100, 42)
	if task == nil {
		t.Fatal("首次创建应返回任务本体")
	}
	if existing != nil {
		t.Fatal("首次创建不应返回已有任务")
	}
	if task.State() != m3uImportRunning {
		t.Fatalf("新建任务状态 = %q, want running", task.State())
	}

	// 进度快照字段自洽
	task.recordBatch(20, 15)
	p := task.progress()
	if p.Total != 100 || p.Processed != 20 || p.Matched != 15 {
		t.Fatalf("进度字段不对: %+v", p)
	}
	if p.Skipped != 5 {
		t.Fatalf("skipped 应为 processed-matched=5, 实际 %d", p.Skipped)
	}
	if p.Percent != 20 {
		t.Fatalf("percent 应为 20, 实际 %d", p.Percent)
	}

	// 完成:percent 必须顶到 100,哪怕 processed < total
	task.finish(m3uImportDone, "", 100, 88)
	p = task.progress()
	if p.State != m3uImportDone {
		t.Fatalf("状态 = %q, want done", p.State)
	}
	if p.Percent != 100 {
		t.Fatalf("done 状态 percent 必须是 100, 实际 %d", p.Percent)
	}
	if p.Matched != 88 || p.Skipped != 12 {
		t.Fatalf("完成时 matched/skipped 不对: %+v", p)
	}
}

func TestM3UImportTaskPercentNeverExceedsHundred(t *testing.T) {
	resetM3UImportTaskStore(t)
	task, _ := newM3UImportTask(1, "x", 10, 1)
	// 防御性:processed 超过 total(理论上不该,但别让前端进度条爆掉)
	task.recordBatch(999, 999)
	if got := task.progress().Percent; got > 100 {
		t.Fatalf("percent 超过 100: %d", got)
	}
}

func TestM3UImportTaskZeroTotalDoesNotDivideByZero(t *testing.T) {
	resetM3UImportTaskStore(t)
	// total=0 是退化输入(理论上前面已挡住空歌单),但不能因此 panic。
	task, _ := newM3UImportTask(1, "x", 0, 1)
	if got := task.progress().Percent; got != 0 {
		t.Fatalf("total=0 时 percent 应为 0, 实际 %d", got)
	}
}

func TestM3UImportTaskIsolatedPerUser(t *testing.T) {
	resetM3UImportTaskStore(t)
	task, _ := newM3UImportTask(7, "alice 的导入", 10, 1)

	if lookupM3UImportTask(task.ID, 7) == nil {
		t.Fatal("任务所有者应能查到自己的任务")
	}
	// ★ 跨用户必须查不到(handler 据此回 404,不泄露存在性)
	if lookupM3UImportTask(task.ID, 8) != nil {
		t.Fatal("其他用户不应查到该任务 —— 跨用户访问要按 404 处理")
	}
	// 不存在的 id
	if lookupM3UImportTask("nope", 7) != nil {
		t.Fatal("不存在的任务应返回 nil")
	}
}

func TestM3UImportTaskRefusesSecondRunningTask(t *testing.T) {
	resetM3UImportTaskStore(t)

	first, existing := newM3UImportTask(7, "第一次", 10, 1)
	if first == nil || existing != nil {
		t.Fatal("第一次创建应成功")
	}

	second, existing := newM3UImportTask(7, "第二次", 20, 2)
	if second != nil {
		t.Fatal("已有进行中任务时不应创建新任务")
	}
	if existing == nil || existing.ID != first.ID {
		t.Fatal("应返回已有的那个任务,让 handler 提示 already_running")
	}

	// 第一个结束后,应允许再建
	first.finish(m3uImportDone, "", 10, 10)
	first.detach()
	third, existing := newM3UImportTask(7, "第三次", 5, 3)
	if third == nil || existing != nil {
		t.Fatal("前一个任务结束后应允许新建")
	}
}

func TestM3UImportTaskCancelIsIdempotent(t *testing.T) {
	resetM3UImportTaskStore(t)
	task, _ := newM3UImportTask(7, "x", 100, 1)

	if task.Cancelled() {
		t.Fatal("新建任务不应是已取消")
	}
	task.Cancel()
	if !task.Cancelled() {
		t.Fatal("取消后 Cancelled() 应为 true")
	}
	if task.State() != m3uImportCancelled {
		t.Fatalf("取消后状态 = %q, want cancelled", task.State())
	}

	// ★ 重复取消不能 panic(close of closed channel)
	task.Cancel()
	task.Cancel()
	if task.State() != m3uImportCancelled {
		t.Fatalf("重复取消后状态 = %q", task.State())
	}
}

func TestM3UImportTaskCancelledKeepsActualProgress(t *testing.T) {
	resetM3UImportTaskStore(t)
	task, _ := newM3UImportTask(7, "x", 100, 1)
	task.recordBatch(40, 30)
	task.Cancel()

	p := task.progress()
	// 取消不是完成:percent 保持实际进度,不能顶到 100
	// (否则前端进度条显示"100% 但失败",自相矛盾)
	if p.Percent != 40 {
		t.Fatalf("取消后 percent 应保持实际 40, 实际 %d", p.Percent)
	}
	if p.State != m3uImportCancelled {
		t.Fatalf("状态 = %q", p.State)
	}
}

func TestM3UImportTaskPrunesExpiredTerminalTasks(t *testing.T) {
	resetM3UImportTaskStore(t)

	task, _ := newM3UImportTask(7, "旧任务", 10, 1)
	task.finish(m3uImportDone, "", 10, 10)
	task.detach()
	// 人为把它改成"很久以前更新"
	task.mu.Lock()
	task.updatedAt = time.Now().Add(-2 * m3uImportTaskRetention)
	task.mu.Unlock()

	// 新建任务会触发惰性清理
	fresh, _ := newM3UImportTask(8, "新任务", 5, 2)
	if fresh == nil {
		t.Fatal("清理后应能正常新建")
	}
	if lookupM3UImportTask(task.ID, 7) != nil {
		t.Fatal("过期的已结束任务应被清掉")
	}
}

// TestM3UImportTaskConcurrentRecordAndRead 并发读写不炸、且快照自洽。
//
// 这是真实并发:后台 goroutine 写进度、HTTP handler 读进度。
func TestM3UImportTaskConcurrentRecordAndRead(t *testing.T) {
	resetM3UImportTaskStore(t)
	task, _ := newM3UImportTask(7, "并发", 1000, 1)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 1; i <= 200; i++ {
			task.recordBatch(i, i/2)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			p := task.progress()
			// 每次快照都必须字段自洽
			if p.Skipped != p.Processed-p.Matched {
				t.Errorf("快照不自洽: processed=%d matched=%d skipped=%d",
					p.Processed, p.Matched, p.Skipped)
				return
			}
		}
	}()
	wg.Wait()
}

// TestM3UImportReportsOnTimeBeforeBatchFills 守住"进度不能长时间停在 0%"。
//
// ★ 这条是真机数据验证后补的（2026-11-25）。用 NAS 上的真实歌单实测发现：
//
//	日语歌曲.m3u8（163 条，2.29 秒/条）的进度采样
//	   0.0s    0%    0/163
//	  47.1s   12%   20/163   ← 前 47 秒一直是 0%
//
// 原因是只有"每 20 条上报一次"这一个粒度，凑够 20 条要 45 秒。
// 用户点完导入后 45 秒看不到任何变化，会以为卡死并刷新页面。
//
// 修法：加时间粒度（10 秒），与条数粒度取先到者。
func TestM3UImportReportsOnTimeBeforeBatchFills(t *testing.T) {
	// 刚处理 1 条、1 秒前刚上报过 → 不该上报（条数没到、时间没到）
	if shouldReportProgress(1, time.Now().Add(-time.Second)) {
		t.Fatal("处理 1 条且刚上报过，不应上报")
	}
	// 处理 3 条、但已过 11 秒 → 必须上报（否则用户看不到进度）
	if !shouldReportProgress(3, time.Now().Add(-11*time.Second)) {
		t.Fatal("距上次上报超过 10 秒必须上报，否则大歌单前 45 秒都显示 0%")
	}
	// 处理正好 20 条（批次边界）→ 立即上报，哪怕刚上报过
	if !shouldReportProgress(20, time.Now()) {
		t.Fatal("凑够 20 条应立即上报")
	}
	// 处理 40 条同样
	if !shouldReportProgress(40, time.Now()) {
		t.Fatal("凑够 40 条应立即上报")
	}
	// processed=0 时不该因条数上报（0%20==0 但还没处理任何东西）
	if shouldReportProgress(0, time.Now()) {
		t.Fatal("processed=0 不应因条数规则上报")
	}
}

// TestM3UImportReportIntervalIsSmallEnough 时间粒度必须足够小。
//
// 判据来自真机:单条耗时实测 2.29 秒。若上报间隔 > 30 秒，用户会觉得"卡住"。
// 这里把它钉在 10 秒，并说明为什么不是更大或更小。
func TestM3UImportReportIntervalIsSmallEnough(t *testing.T) {
	if m3uImportReportInterval > 15*time.Second {
		t.Fatalf("上报间隔 %v 太大 —— 真机实测单条 2.29 秒，"+
			"间隔过长会让进度条长时间不动", m3uImportReportInterval)
	}
	if m3uImportReportInterval < 2*time.Second {
		t.Fatalf("上报间隔 %v 太小 —— 前端 1 秒才轮询一次，"+
			"更频繁的上报只是多几次锁竞争", m3uImportReportInterval)
	}
}

// TestM3UImportHandlerReturnsTaskContract 验证 handler 不再同步跑完。
//
// 做法:发一个 1 条目的导入(会真去搜索),断言**响应立刻返回且带 task_id**,
// 而不是等搜索完。条目只有 1 条,即使真跑完也很快 —— 所以这个用例的
// 价值主要在"响应体形状"上:必须是 task 契约,不是旧的 {id,name,total,matched}。
func TestM3UImportHandlerReturnsTaskContract(t *testing.T) {
	initCollectionDBForTest(t)
	resetM3UImportTaskStore(t)

	router := newCollectionTestRouter()
	content := "#EXTM3U\n#EXTINF:219,测试歌手 - 测试歌名\n/local/a.flac\n"

	bodyBytes, err := json.Marshal(map[string]string{"name": "契约测试", "content": content})
	if err != nil {
		t.Fatalf("构造请求体失败: %v", err)
	}
	req := httptest.NewRequest(
		http.MethodPost,
		RoutePrefix+"/collections/import_m3u",
		bytes.NewReader(bodyBytes),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v (body=%s)", err, rec.Body.String())
	}
	for _, key := range []string{"task_id", "id", "name", "total", "state"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("响应缺少 %q 字段(新契约必须返回 task): %s", key, rec.Body.String())
		}
	}
	if payload["state"] != string(m3uImportRunning) {
		t.Fatalf("state = %v, want running", payload["state"])
	}
	// 旧契约的两个字段:matched/skipped 现在由**轮询接口**返回,
	// 提交时还不知道结果,所以不能出现在这里(出现了说明又在同步跑)。
	if _, ok := payload["matched"]; ok {
		t.Fatal("提交响应不应含 matched —— 那说明还在同步等待搜索完成")
	}
}
