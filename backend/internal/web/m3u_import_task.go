package web

// m3u 导入任务的状态机与存储(2026-11 全库扫描, P2-13 方案 C)。
//
// ## 为什么必须改
//
// 原实现是**同步阻塞**:解析完 m3u 后在请求里逐条跑 `concurrentKeywordSearch`,
// 全部跑完才返回。而:
//   · 条目上限 1000 条(`maxM3UEntries`);
//   · 每条一次全源并发搜索,主力源实测 1~2 秒;
//   · 前端 axios 超时 600 秒(`collections.js`)。
//
// 于是 1000 条的导入需要 1000~2000 秒,前端 600 秒就放弃 ——
// 而 `db.Create(&coll)` 在循环**之前**执行,所以**歌单已经建好、歌也在一首首加**,
// 用户却看到"导入失败"。刷新一下歌单又出现了。
// 这是最容易让人以为"软件有鬼"的行为,必须消掉。
//
// ## 方案 C 的形状:提交即返回 + 轮询进度
//
//   POST /collections/import_m3u  → 解析、建歌单、**启动后台任务**,立即返回 task_id
//   GET  /collections/import_m3u/tasks/:id → 返回 {state, total, processed, matched, ...}
//
// 为什么用轮询而不是 SSE:
//   · 本项目此前**没有任何 SSE 先例**(已 grep 确认),引入它要处理 Flush 时机、
//     反代缓冲、断线重连、鉴权 cookie 路径等一堆新问题;
//   · 这个任务的进度更新是"每批一次"(秒级),轮询 1 秒完全够用,不需要推送;
//   · 轮询失败/页面刷新后重新接上都很自然,SSE 断线要自己补。
//   结论:用最笨但最可靠的方式。
//
// ## 关键设计点
//
// 1. **任务快照与歌单解耦**:任务只记录进度,歌单本身照常逐条写入。
//    用户即使关掉页面,后台仍会把歌单导完 —— 这是原实现就有的行为
//    (同步请求被前端放弃时后端还在跑),现在只是让它可见可控。
//
// 2. **任务归属按用户隔离**:`UserID` 必须匹配才能查,否则 A 能看到 B 的导入进度。
//    与项目既有的"跨用户访问按 404 处理(不泄露存在性)"一致。
//
// 3. **任务有生命周期上限**:完成的保留 10 分钟供前端取结果,过期的惰性清理。
//    不做的话每导入一次就留一条,长期驻留进程会慢慢涨。
//
// 4. **同一用户同时只允许一个导入任务**:第二个请求直接返回已有任务 id。
//    理由:每条都打全源搜索,两个人(或同一人开两个标签)同时导入会把上游打爆,
//    这与项目"绝不提高上游并发"的纪律方向相反。

import (
	"fmt"
	"sync"
	"time"
)

// m3uImportState 是任务的公开状态。用字符串而不是 int,
// 是为了让前端 / 排查日志里直接读懂,不用再对一遍枚举。
type m3uImportState string

const (
	// m3uImportRunning 正在逐条匹配。
	m3uImportRunning m3uImportState = "running"
	// m3uImportDone 全部处理完毕(不代表全部匹配成功)。
	m3uImportDone m3uImportState = "done"
	// m3uImportFailed 任务本身崩了(建歌单后写库异常等)。
	m3uImportFailed m3uImportState = "failed"
	// m3uImportCancelled 用户主动取消。
	m3uImportCancelled m3uImportState = "cancelled"
)

// m3uImportTaskRetention 是任务完成后保留多久供前端取结果。
//
// 10 分钟的依据:前端轮询间隔 1 秒,用户看到"完成"后基本立刻读走;
// 留 10 分钟足够覆盖"页面刷新后再回来看看结果",又不会让内存长期堆积。
const m3uImportTaskRetention = 10 * time.Minute

// m3uImportBatchSize 是进度上报的**条数**粒度（每处理多少条更新一次进度）。
const m3uImportBatchSize = 20

// m3uImportReportInterval 是进度上报的**时间**粒度上限。
//
// ★ 为什么需要两个粒度（真机数据验证后补的，2026-11-25）：
//
//	最初只有条数粒度（每 20 条上报一次）。用 NAS 上的真实歌单实测发现
//	这个设计有个明显缺陷：
//
//	  日语歌曲.m3u8（163 条，实测 2.29 秒/条）的进度采样：
//	      0.0s    0%      0/163
//	     47.1s   12%     20/163   ← 前 47 秒一直是 0%!
//	     94.2s   24%     40/163
//	     ...
//
//	也就是用户点完导入后，**45 秒内看不到任何进度变化**。
//	1000 条的歌单同样是 45 秒才第一次更新 —— 这段时间足够让人以为卡死并刷新页面。
//
//	所以再加一条时间粒度：距上次上报超过 10 秒就上报，不管凑够了多少条。
//	两者取**先到者**。这样：
//	  · 快的时候（小歌单/响应快）按条数走，不会因为频繁上报产生锁竞争；
//	  · 慢的时候（大歌单/上游慢）最多 10 秒就有一次可见更新，不会"假死"。
const m3uImportReportInterval = 10 * time.Second

// shouldReportProgress 判断当前是否该上报一次进度。
//
// 两个条件取先到者：处理条数达到批次，或距上次上报已超过时间上限。
// lastReport 由调用方维护（后台循环是单 goroutine，不需要加锁）。
func shouldReportProgress(processed int, lastReport time.Time) bool {
	if processed > 0 && processed%m3uImportBatchSize == 0 {
		return true
	}
	return time.Since(lastReport) >= m3uImportReportInterval
}

// m3uImportTask 是一个导入任务的运行时状态。
//
// 所有字段都在 mu 保护下读写:后台 goroutine 写、HTTP handler 读,
// 这是真实的并发访问,不是"可能并发"。
type m3uImportTask struct {
	ID           string
	UserID       uint
	Name         string
	Total        int
	collectionID uint

	mu        sync.RWMutex
	state     m3uImportState
	processed int
	matched   int
	message   string // 失败/取消原因,或完成时的补充说明
	updatedAt time.Time
	// cancel 让"取消"能把正在跑的后台 goroutine 停下来,
	// 否则用户点了取消、请求返回了,后台还在继续打上游。
	cancel chan struct{}
}

// m3uImportProgress 是给前端的进度快照(纯数据,不含锁与 channel)。
type m3uImportProgress struct {
	TaskID       string         `json:"task_id"`
	CollectionID uint           `json:"collection_id"`
	Name         string         `json:"name"`
	State        m3uImportState `json:"state"`
	Total        int            `json:"total"`
	Processed    int            `json:"processed"`
	Matched      int            `json:"matched"`
	Skipped      int            `json:"skipped"`
	Message      string         `json:"message,omitempty"`
	// Percent 由后端算好,免得前端各写一遍除法(还会忘掉 total=0 的除零保护)。
	Percent int `json:"percent"`
}

var m3uImportTaskStore = struct {
	sync.Mutex
	tasks map[string]*m3uImportTask
	// byUser 用于"同一用户只允许一个进行中任务"的判定。
	byUser map[uint]string
}{
	tasks:  map[string]*m3uImportTask{},
	byUser: map[uint]string{},
}

// newM3UImportTask 创建一个任务并登记到存储。
//
// 返回任务与其"已有进行中任务"的提示:若该用户已有 running 任务,
// 不新建,直接返回那个(调用方据此回 200 + 已有 task_id,而不是再造一份)。
func newM3UImportTask(userID uint, name string, total int, collectionID uint) (*m3uImportTask, *m3uImportTask) {
	m3uImportTaskStore.Lock()
	defer m3uImportTaskStore.Unlock()

	// 惰性清理过期任务 —— 不单起 GC goroutine,因为这张表本来就很小。
	pruneM3UImportTasksLocked()

	if existingID, ok := m3uImportTaskStore.byUser[userID]; ok {
		if existing := m3uImportTaskStore.tasks[existingID]; existing != nil && existing.State() == m3uImportRunning {
			return nil, existing
		}
	}

	task := &m3uImportTask{
		ID:        fmt.Sprintf("m3u-%d-%d", userID, time.Now().UnixNano()),
		UserID:    userID,
		Name:      name,
		Total:     total,
		state:     m3uImportRunning,
		updatedAt: time.Now(),
		cancel:    make(chan struct{}),
		// collectionID 存进 message 不合适,这里用单独字段。
		collectionID: collectionID,
	}
	m3uImportTaskStore.tasks[task.ID] = task
	m3uImportTaskStore.byUser[userID] = task.ID
	return task, nil
}

// pruneM3UImportTasksLocked 清掉已结束且超过保留期的任务。
// 调用方必须已持有 m3uImportTaskStore 的锁。
func pruneM3UImportTasksLocked() {
	cutoff := time.Now().Add(-m3uImportTaskRetention)
	for id, task := range m3uImportTaskStore.tasks {
		if task.State() != m3uImportRunning && task.UpdatedAt().Before(cutoff) {
			delete(m3uImportTaskStore.tasks, id)
			if m3uImportTaskStore.byUser[task.UserID] == id {
				delete(m3uImportTaskStore.byUser, task.UserID)
			}
		}
	}
}

// lookupM3UImportTask 按 id 与用户取任务。
//
// ★ 用户不匹配时返回 nil(而不是"先找到再判断"),让 handler 统一回 404 ——
// 与项目既有纪律一致:跨用户访问不泄露存在性。
func lookupM3UImportTask(taskID string, userID uint) *m3uImportTask {
	m3uImportTaskStore.Lock()
	defer m3uImportTaskStore.Unlock()
	task := m3uImportTaskStore.tasks[taskID]
	if task == nil || task.UserID != userID {
		return nil
	}
	return task
}

// State / UpdatedAt 供清理逻辑在无锁路径上安全读取。
func (t *m3uImportTask) State() m3uImportState {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.state
}

// UpdatedAt 返回最后一次进度更新时间(用于过期清理)。
func (t *m3uImportTask) UpdatedAt() time.Time {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.updatedAt
}

// Cancelled 返回 true 表示用户已要求取消,后台循环应尽快退出。
func (t *m3uImportTask) Cancelled() bool {
	select {
	case <-t.cancel:
		return true
	default:
		return false
	}
}

// Cancel 请求取消。重复调用安全(close 只对未关闭的 channel 生效,这里用 once 语义)。
func (t *m3uImportTask) Cancel() {
	t.mu.Lock()
	defer t.mu.Unlock()
	select {
	case <-t.cancel:
		// 已取消过,不重复 close(否则 panic: close of closed channel)。
	default:
		close(t.cancel)
	}
	if t.state == m3uImportRunning {
		t.state = m3uImportCancelled
		t.message = "已取消"
		t.updatedAt = time.Now()
	}
}

// recordBatch 汇报一批处理结果(每 m3uImportBatchSize 条调一次)。
func (t *m3uImportTask) recordBatch(processed, matched int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.processed = processed
	t.matched = matched
	t.updatedAt = time.Now()
}

// finish 收尾:标记终态与原因。
func (t *m3uImportTask) finish(state m3uImportState, message string, processed, matched int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.state = state
	t.message = message
	t.processed = processed
	t.matched = matched
	t.updatedAt = time.Now()
}

// progress 生成给前端的快照。
func (t *m3uImportTask) progress() m3uImportProgress {
	t.mu.RLock()
	defer t.mu.RUnlock()

	percent := 0
	if t.Total > 0 {
		percent = t.processed * 100 / t.Total
		if percent > 100 {
			percent = 100
		}
	}
	// 已结束的任务:完成后 processed 可能小于 total(取消)或等于 total。
	// 只有在真正 done 时才把百分比顶到 100,取消/失败保持实际进度,
	// 否则前端进度条会显示"100% 但状态是失败",自相矛盾。
	if t.state == m3uImportDone {
		percent = 100
	}

	return m3uImportProgress{
		TaskID:       t.ID,
		CollectionID: t.collectionID,
		Name:         t.Name,
		State:        t.state,
		Total:        t.Total,
		Processed:    t.processed,
		Matched:      t.matched,
		Skipped:      t.processed - t.matched,
		Message:      t.message,
		Percent:      percent,
	}
}

// 已结束任务从 byUser 里摘掉 —— 否则同一用户永远只能有一个"历史任务 id",
// 第二次导入会被误判成"已有进行中任务"。
func (t *m3uImportTask) detach() {
	m3uImportTaskStore.Lock()
	defer m3uImportTaskStore.Unlock()
	if m3uImportTaskStore.byUser[t.UserID] == t.ID {
		delete(m3uImportTaskStore.byUser, t.UserID)
	}
}
