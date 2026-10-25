package web

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 「搜索结果专辑索引」:把 search_cache_rows 里所有搜索结果的 (source, song_id) → {album, album_id}
// 一次性摊平成进程内 map,替代改造前「每首缺 album 的歌各发一次全表 LIKE」的 N+1。
//
// 改造前的实测(生产 NAS,postgres,search_cache_rows 238 行 / 9.7MB / 单行最大 240KB):
// GET /music/collections/8/songs(99 首,15 首缺 album)= 755~828ms,
// 单次 `payload LIKE '%"id":"<songid>"%'` 约 52ms,15 × 52 ≈ 780ms,与实测吻合;
// 而 19 首且 0 首缺 album 的歌单只要 32ms。对齐到 sqlite 基准同样是
// 「缺 album 歌数 × ~15ms」,即耗时随缺元数据的歌数线性增长。
//
// 现在的路径:构建时扫一次表(流式、只读、SQL 与驱动无关),查询路径上只做 O(1) map 查找;
// 命中后仍照旧回写 saved_songs.extra / play_history_rows.extra,后续请求不再依赖索引。
//
// 注意:search_cache 本身是全局共享的(不按用户隔离),所以这个索引也全局共享,
// 不得混进任何用户态。
const (
	searchAlbumIndexDefaultTTL          = 15 * time.Minute
	searchAlbumIndexBuildRetryBackoff   = 10 * time.Second
	searchAlbumIndexMaxEntries          = 200_000
	searchAlbumIndexMaxScanRows         = 5000
	searchAlbumIndexMaxScanPayloadBytes = 64 << 20
)

var (
	searchAlbumIndexMu        sync.RWMutex
	searchAlbumIndexEntries   map[string]cachedAlbumMetadata
	searchAlbumIndexExpiresAt time.Time
	searchAlbumIndexReady     bool
	searchAlbumIndexFailAt    time.Time
	// searchAlbumIndexBuildMu 串行化构建,避免并发请求同时扫全表。
	searchAlbumIndexBuildMu sync.Mutex
	// searchAlbumIndexRebuilding 保证同一时间只有一个后台重建 goroutine。
	searchAlbumIndexRebuilding atomic.Bool
	// searchAlbumIndexGeneration 在每次 invalidate 时自增。扫描开始前记下代数,
	// 发布结果时若代数已变,说明扫描期间缓存被删过 —— 那份快照可能包含已删除的行,
	// 必须丢弃重扫,否则 deleteCachedSearchKey 之后已删歌曲的专辑会被重新灌回索引。
	searchAlbumIndexGeneration atomic.Uint64

	// searchAlbumIndexForceLegacy 仅供测试:置 true 时强制走改造前的逐首 LIKE 路径,
	// 用于证明查询计数回归测试确实锁住了 N+1(禁用索引后同一请求会退化成每首一次 LIKE)。
	searchAlbumIndexForceLegacy atomic.Bool
)

// lookupAlbumMetadataInSearchCache 是专辑元数据 hydration 的唯一入口(song 与 play_history 共用)。
func lookupAlbumMetadataInSearchCache(source, songID string) (cachedAlbumMetadata, bool) {
	source = strings.TrimSpace(source)
	songID = strings.TrimSpace(songID)
	if db == nil || source == "" || songID == "" {
		return cachedAlbumMetadata{}, false
	}
	if searchAlbumIndexForceLegacy.Load() {
		return lookupAlbumMetadataInSearchCacheLegacy(source, songID)
	}
	if !searchAlbumIndexEnsure() {
		// 索引确实不可用(扫表失败/DB 异常)时退回改造前的逐首 LIKE,保证功能不退化。
		// 正常情况下这条分支不会走到,所以不会再出现 N+1。
		return lookupAlbumMetadataInSearchCacheLegacy(source, songID)
	}
	// 读必须在 RLock 内完成:putCachedSearch 会拿写锁往同一张 map 里做增量合并,
	// 把 map 引用交出去读、再在锁外索引,是真正的并发读写 map(data race / 直接 panic)。
	// 单次 RLock + map 查找的成本可以忽略,163 首也就是 163 次无竞争读锁。
	searchAlbumIndexMu.RLock()
	meta, found := searchAlbumIndexEntries[searchAlbumIndexKey(source, songID)]
	searchAlbumIndexMu.RUnlock()
	if !found && !searchAlbumIndexReadyNow() {
		// 极端交错:ensure 返回后、读之前索引刚好被 invalidate(entries 置 nil)。
		// 这时"未命中"没有意义,退回逐首 LIKE 而不是谎报没有专辑。
		return lookupAlbumMetadataInSearchCacheLegacy(source, songID)
	}
	// 索引就绪时,未命中即"搜索结果里确实没有这首",不会再逐首查库 ——
	// 命中/未命中都是廉价判断,未命中在一个 TTL 内也不会反复触发扫描。
	return meta, found
}

func searchAlbumIndexReadyNow() bool {
	searchAlbumIndexMu.RLock()
	ready := searchAlbumIndexReady && searchAlbumIndexEntries != nil
	searchAlbumIndexMu.RUnlock()
	return ready
}

// searchAlbumIndexEnsure 保证索引可用:未就绪则同步构建,已过期则先用旧快照并后台重建。
func searchAlbumIndexEnsure() bool {
	searchAlbumIndexMu.RLock()
	ready, expired := searchAlbumIndexReady, !time.Now().Before(searchAlbumIndexExpiresAt)
	searchAlbumIndexMu.RUnlock()
	if ready {
		if expired {
			// 过期不阻塞请求:继续用旧快照(专辑元数据是只增不改的静态信息,旧值仍然正确),
			// 同时单飞后台重建。这样周期性的重建永远不会落到某个用户的请求延迟上。
			searchAlbumIndexRebuildAsync()
		}
		return true
	}
	return buildSearchAlbumIndex()
}

// lookupAlbumMetadataInSearchCacheLegacy 是改造前的逐首全表 LIKE 查询,现在只作兜底。
func lookupAlbumMetadataInSearchCacheLegacy(source, songID string) (cachedAlbumMetadata, bool) {
	if db == nil {
		return cachedAlbumMetadata{}, false
	}
	encodedID, err := json.Marshal(songID)
	if err != nil {
		return cachedAlbumMetadata{}, false
	}
	pattern := "%\"id\":" + string(encodedID) + "%"

	var rows []searchCacheRow
	if err := db.Where("payload LIKE ?", pattern).Limit(25).Find(&rows).Error; err != nil {
		return cachedAlbumMetadata{}, false
	}
	for _, row := range rows {
		var resp jsonSearchResponse
		if err := json.Unmarshal([]byte(row.Payload), &resp); err != nil {
			continue
		}
		if meta, ok := findAlbumMetadataInSongs(resp.Songs, source, songID); ok {
			return meta, true
		}
	}
	return cachedAlbumMetadata{}, false
}

func searchAlbumIndexTTL() time.Duration {
	return durationFromEnv("MUSIC_DL_SEARCH_ALBUM_INDEX_TTL", searchAlbumIndexDefaultTTL)
}

// searchAlbumIndexKey 拼 (source, song_id) 的 map key。用 \x00 分隔:
// 平台 source 是固定枚举,不可能含 NUL,因此不存在拼接歧义。
func searchAlbumIndexKey(source, songID string) string {
	return source + "\x00" + songID
}

// buildSearchAlbumIndex 构建索引(仅当尚未就绪)。失败返回 false,由调用方退回逐首 LIKE。
// 失败后会短暂退避,避免每次 hydration 都重扫一遍全表。
func buildSearchAlbumIndex() bool {
	searchAlbumIndexBuildMu.Lock()
	defer searchAlbumIndexBuildMu.Unlock()

	// 双检:等锁期间可能已有别的 goroutine 建好。
	searchAlbumIndexMu.RLock()
	ready := searchAlbumIndexReady
	failedRecently := !searchAlbumIndexFailAt.IsZero() && time.Since(searchAlbumIndexFailAt) < searchAlbumIndexBuildRetryBackoff
	searchAlbumIndexMu.RUnlock()
	if ready {
		return true
	}
	if failedRecently {
		return false
	}
	return scanAndPublishSearchAlbumIndex()
}

// scanAndPublishSearchAlbumIndex 扫表并发布结果。调用方必须持有 searchAlbumIndexBuildMu,
// 这样同步构建与后台重建永远不会同时扫表。
func scanAndPublishSearchAlbumIndex() bool {
	// 记录扫描开始时的代数:若扫描期间缓存被删过(invalidate 会自增代数),
	// 这份快照就不再可信,必须重扫。
	generation := searchAlbumIndexGeneration.Load()
	entries, ok := scanSearchAlbumIndexEntries()
	if !ok {
		searchAlbumIndexMu.Lock()
		searchAlbumIndexFailAt = time.Now()
		searchAlbumIndexMu.Unlock()
		log.Printf("[collection] 搜索结果专辑索引构建失败,本次退回逐首缓存查询")
		return false
	}
	if searchAlbumIndexGeneration.Load() != generation {
		// 扫描期间有删除操作,快照可能残留已删行:丢弃,让下一次查找重扫。
		searchAlbumIndexMu.Lock()
		searchAlbumIndexEntries = nil
		searchAlbumIndexReady = false
		searchAlbumIndexExpiresAt = time.Time{}
		searchAlbumIndexMu.Unlock()
		log.Printf("[collection] 搜索结果专辑索引扫描期间缓存被删除,丢弃本次快照并等待重扫")
		return false
	}

	searchAlbumIndexMu.Lock()
	searchAlbumIndexEntries = entries
	searchAlbumIndexReady = true
	searchAlbumIndexExpiresAt = time.Now().Add(searchAlbumIndexTTL())
	searchAlbumIndexFailAt = time.Time{}
	searchAlbumIndexMu.Unlock()
	return true
}

// searchAlbumIndexRebuildAsync 后台重建(单飞)。
// 拿 buildMu 再扫表,与请求路径上的同步构建互斥 —— 否则索引过期的那一刻,
// 一个重建 goroutine 与一次同步构建可能同时把整表解码一遍。
func searchAlbumIndexRebuildAsync() {
	if !searchAlbumIndexRebuilding.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer searchAlbumIndexRebuilding.Store(false)
		searchAlbumIndexBuildMu.Lock()
		defer searchAlbumIndexBuildMu.Unlock()
		// 等锁期间索引可能已被别人重建/失效处理过,直接重扫是幂等的。
		if !scanAndPublishSearchAlbumIndex() {
			log.Printf("[collection] 搜索结果专辑索引后台重建失败,继续沿用旧快照")
		}
	}()
}

// scanSearchAlbumIndexEntries 流式扫描 search_cache_rows,把 payload 里的歌曲元数据摊平成索引。
// 只发一条 SELECT(不分驱动、不用 pg 特有能力);行数/字节/条目三道上限保证极端库也吃不穿内存。
func scanSearchAlbumIndexEntries() (map[string]cachedAlbumMetadata, bool) {
	currentDB := db
	if currentDB == nil {
		return nil, false
	}
	rows, err := currentDB.Model(&searchCacheRow{}).Select("payload").Rows()
	if err != nil {
		return nil, false
	}
	defer rows.Close()

	entries := make(map[string]cachedAlbumMetadata, 256)
	scannedRows, scannedBytes := 0, 0
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, false
		}
		scannedRows++
		scannedBytes += len(payload)
		mergeSearchAlbumIndexPayload(entries, payload)
		if scannedRows >= searchAlbumIndexMaxScanRows ||
			scannedBytes >= searchAlbumIndexMaxScanPayloadBytes ||
			len(entries) >= searchAlbumIndexMaxEntries {
			// 到达上限:保留已扫到的部分(可用的子集,不会给出错误数据),
			// 只是超出的行这次不参与,不会比"完全不建索引"更差。
			log.Printf("[collection] 搜索结果专辑索引达到扫描上限(rows=%d bytes=%d entries=%d),已按已扫内容构建", scannedRows, scannedBytes, len(entries))
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, false
	}
	return entries, true
}

// mergeSearchAlbumIndexPayload 解析一行搜索缓存 payload 并并入索引。
// 单行损坏只跳过该行(与旧实现的 `continue` 一致),不影响其它行。
func mergeSearchAlbumIndexPayload(entries map[string]cachedAlbumMetadata, payload string) {
	if strings.TrimSpace(payload) == "" {
		return
	}
	var resp jsonSearchResponse
	if err := json.Unmarshal([]byte(payload), &resp); err != nil {
		return
	}
	mergeSearchAlbumIndexSongs(entries, resp.Songs)
}

func mergeSearchAlbumIndexSongs(entries map[string]cachedAlbumMetadata, songs []model.Track) {
	for _, song := range songs {
		source := strings.TrimSpace(song.Source)
		songID := strings.TrimSpace(song.ID)
		if source == "" || songID == "" {
			continue
		}
		meta, ok := albumMetadataFromTrack(song)
		if !ok {
			continue
		}
		entries[searchAlbumIndexKey(source, songID)] = meta
	}
}

// mergeSearchAlbumIndexFromResponse 在搜索缓存写成功后把新结果的专辑元数据增量并入索引。
//
// 为什么是"合并"而不是整体置为失效:putCachedSearch 在每次搜索(以及后台补齐)后都会调用,
// 若整体失效,下一次打开歌单就要重扫 9.7MB 全表 —— 一次搜索换来一次全表扫描,反而更慢。
// 合并是"失效"的超集:刚写入的 (source, song_id) 一定拿到最新值,不会读到旧数据;
// 真正无法增量维护的删除路径(deleteCachedSearchKey)才整体失效。
// 索引尚未就绪时不做事:下次查找会整体重建,自然包含这次写入的内容。
func mergeSearchAlbumIndexFromResponse(resp jsonSearchResponse) {
	entries := make(map[string]cachedAlbumMetadata, len(resp.Songs))
	mergeSearchAlbumIndexSongs(entries, resp.Songs)
	if len(entries) == 0 {
		return
	}
	searchAlbumIndexMu.Lock()
	defer searchAlbumIndexMu.Unlock()
	// 必须在写锁内再判一次"索引当前可用":否则可能刚被 invalidate(entries=nil,ready=false)
	// 又被这里塞进半份数据,留下"有 entries 但未就绪"的中间态。
	if !searchAlbumIndexReady || !time.Now().Before(searchAlbumIndexExpiresAt) || searchAlbumIndexEntries == nil {
		return
	}
	for key, meta := range entries {
		searchAlbumIndexEntries[key] = meta
	}
}

// invalidateSearchAlbumIndex 丢弃索引,下一次查找会重建。
// 删除缓存行时无法反推它贡献了哪些 (source,song_id),所以这里只能整体失效。
func invalidateSearchAlbumIndex() {
	// 先自增代数再清数据:正在跑的扫描据此判定快照过期,不会把已删内容发布回来。
	searchAlbumIndexGeneration.Add(1)
	searchAlbumIndexMu.Lock()
	searchAlbumIndexEntries = nil
	searchAlbumIndexReady = false
	searchAlbumIndexExpiresAt = time.Time{}
	searchAlbumIndexFailAt = time.Time{}
	searchAlbumIndexMu.Unlock()
}

// resetSearchAlbumIndexForTest 清空索引与测试开关。
// 必须由 resetCollectionStateForTest 调用:索引是包级全局态,不重置会跨用例串数据。
func resetSearchAlbumIndexForTest() {
	invalidateSearchAlbumIndex()
	searchAlbumIndexForceLegacy.Store(false)
}

// warmSearchAlbumIndexAsync 启动后异步预建索引,让部署/重启后的第一次「我的歌单」也不用承担扫表成本。
// 只读 search_cache_rows,不参与任何写入路径;失败时退避后按需重建,不影响功能。
func warmSearchAlbumIndexAsync() {
	if db == nil {
		return
	}
	go func() {
		if !buildSearchAlbumIndex() {
			log.Printf("[collection] 搜索结果专辑索引预建未完成,将在首次需要时重试")
		}
	}()
}
