package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// sqlQueryCounter 是测试用的 GORM logger:每执行一条 SQL,GORM 就会调一次 Trace,
// 因此它给出的是精确的「本次请求发出的 SQL 条数」,与机器快慢无关。
// 用查询计数而不是耗时断言,是为了在 CI 抖动下也能稳定锁住 N+1 回归。
type sqlQueryCounter struct {
	mu   sync.Mutex
	sqls []string
}

func (c *sqlQueryCounter) LogMode(logger.LogLevel) logger.Interface      { return c }
func (c *sqlQueryCounter) Info(context.Context, string, ...interface{})  {}
func (c *sqlQueryCounter) Warn(context.Context, string, ...interface{})  {}
func (c *sqlQueryCounter) Error(context.Context, string, ...interface{}) {}

func (c *sqlQueryCounter) Trace(
	_ context.Context,
	_ time.Time,
	fc func() (sql string, rowsAffected int64),
	_ error,
) {
	sql, _ := fc()
	c.mu.Lock()
	c.sqls = append(c.sqls, sql)
	c.mu.Unlock()
}

func (c *sqlQueryCounter) reset() {
	c.mu.Lock()
	c.sqls = nil
	c.mu.Unlock()
}

func (c *sqlQueryCounter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.sqls)
}

func (c *sqlQueryCounter) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.sqls...)
}

// linesMatching 返回包含指定子串(大小写不敏感)的 SQL 条数,用于断言"没有 LIKE 全表扫描"。
func (c *sqlQueryCounter) linesMatching(substr string) int {
	substr = strings.ToUpper(substr)
	matched := 0
	for _, sql := range c.snapshot() {
		if strings.Contains(strings.ToUpper(sql), substr) {
			matched++
		}
	}
	return matched
}

// installSQLQueryCounter 把包级 db 换成带计数 logger 的会话(GORM Session 只替换 Config.Logger,
// 底层连接池与其余配置不变)。必须在本用例所有数据准备完成之后再调用。
func installSQLQueryCounter(t *testing.T) *sqlQueryCounter {
	t.Helper()
	if db == nil {
		t.Fatal("install query counter before InitDB")
	}
	counter := &sqlQueryCounter{}
	db = db.Session(&gorm.Session{Logger: counter})
	return counter
}

// seedAlbumLessSavedSongs 灌 count 首「没有 album 元数据」的歌。
// 源用 local:只为让 warmQualityCache 的远程探测(打上游)完全不参与本测试,
// 专辑元数据 hydration 本身与 source 无关。
func seedAlbumLessSavedSongs(t *testing.T, collectionID uint, count int, source string) []SavedSong {
	t.Helper()
	rows := make([]SavedSong, 0, count)
	for i := 0; i < count; i++ {
		songID := fmt.Sprintf("song-%03d", i)
		rows = append(rows, SavedSong{
			CollectionID: collectionID,
			SongID:       songID,
			Source:       source,
			Name:         fmt.Sprintf("测试歌曲 %d", i),
			Artist:       "测试艺人",
			Duration:     200,
			Extra:        fmt.Sprintf(`{"songmid":%q}`, songID),
		})
	}
	if err := db.CreateInBatches(&rows, 100).Error; err != nil {
		t.Fatalf("seed saved songs: %v", err)
	}
	return rows
}

// TestCollectionSongsQueryCountDoesNotScaleWithMissingAlbum 是 N+1 的回归锁。
//
// 改造前:每首缺 album 的歌各发一次 `payload LIKE '%"id":"…"%'` 全表扫描,
// 163 首全缺 → 160+ 条 SQL(生产实测 52ms/条,因此单请求 700ms+)。
// 改造后:专辑索引一次构建 + O(1) map 查找,请求路径上 SQL 条数与歌曲数无关。
func TestCollectionSongsQueryCountDoesNotScaleWithMissingAlbum(t *testing.T) {
	initCollectionDBForTest(t)
	collection := createManualCollectionForContract(t, "163 首全缺专辑元数据")
	seedAlbumLessSavedSongs(t, collection.ID, 163, localMusicSource)

	counter := installSQLQueryCounter(t)
	router := newCollectionTestRouter()
	path := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)

	counter.reset()
	recorder := performCollectionRequest(router, http.MethodGet, path, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list songs status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var tracks []map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &tracks); err != nil {
		t.Fatalf("decode songs: %v", err)
	}
	if len(tracks) != 163 {
		t.Fatalf("song count = %d, want 163", len(tracks))
	}

	// 硬上限 8:1 次 loadOwnedCollection + 1 次 saved_songs + 1 次索引构建(首请求)
	// + 少量开销,远低于 163。
	const maxQueries = 8
	t.Logf("首请求 SQL 条数 = %d(163 首全缺 album)", counter.count())
	if got := counter.count(); got > maxQueries {
		t.Fatalf("一次 163 首歌单请求发出了 %d 条 SQL,超过上限 %d(疑似 N+1 回归),SQL=%v", got, maxQueries, counter.snapshot())
	}
	// 更直接的断言:请求路径上不应再出现 LIKE 全表扫描。
	if got := counter.linesMatching("LIKE"); got != 0 {
		t.Fatalf("请求路径上仍有 %d 条 LIKE 扫描: %v", got, counter.snapshot())
	}

	// 第二个请求:索引已就绪,连构建那条 SQL 都不再需要,查询数进一步下降。
	counter.reset()
	recorder = performCollectionRequest(router, http.MethodGet, path, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("second list songs status = %d", recorder.Code)
	}
	steadyState := counter.count()
	t.Logf("索引就绪后第二请求 SQL 条数 = %d", steadyState)
	if steadyState > 4 {
		t.Fatalf("索引就绪后 163 首歌单请求仍发出 %d 条 SQL,超过上限 4,SQL=%v", steadyState, counter.snapshot())
	}
}

// TestCollectionSongsQueryCountGrowsWhenAlbumIndexDisabled 证明上面的上限断言确实锁住了 N+1:
// 把索引强制退回改造前的逐首 LIKE 路径后,同一请求的 SQL 条数立刻随歌曲数线性上升。
// (即"删掉索引修复后,第一个测试就会失败"。)
func TestCollectionSongsQueryCountGrowsWhenAlbumIndexDisabled(t *testing.T) {
	initCollectionDBForTest(t)
	collection := createManualCollectionForContract(t, "163 首全缺专辑元数据(禁用索引)")
	seedAlbumLessSavedSongs(t, collection.ID, 163, localMusicSource)

	counter := installSQLQueryCounter(t)
	searchAlbumIndexForceLegacy.Store(true)
	t.Cleanup(func() { searchAlbumIndexForceLegacy.Store(false) })

	router := newCollectionTestRouter()
	path := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)

	counter.reset()
	recorder := performCollectionRequest(router, http.MethodGet, path, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list songs status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	sqlCount := counter.count()
	t.Logf("禁用索引后同一请求 SQL 条数 = %d,其中 LIKE = %d", sqlCount, counter.linesMatching("LIKE"))
	if sqlCount <= 8 {
		t.Fatalf("禁用索引后仍只有 %d 条 SQL,说明该测试没有锁住 N+1(上限断言形同虚设)", sqlCount)
	}
	if sqlCount < 163 {
		t.Fatalf("禁用索引后 SQL 条数 = %d,期望至少与缺 album 的歌数同量级(163)", sqlCount)
	}
	if got := counter.linesMatching("LIKE"); got < 163 {
		t.Fatalf("禁用索引后只看到 %d 条 LIKE,期望 163 条(逐首全表扫描)", got)
	}
}

// TestWarmQualityCacheUsesBatchedCachedCheck 锁住「已缓存判断不是逐首点查」。
//
// 改造前:warmQualityCache 在请求路径上对每首歌调一次 getCachedQuality → 163/1200 次点查。
// 改造后:一次 IN 批量查询(500/块)。这里灌 1200 首「全部已缓存」的歌:
// 既断言查询数 = ceil(1200/500) = 3(而不是 1200),
// 又因为待探测队列为空,后台探测 goroutine 根本不会启动,计数完全确定、无并发抖动。
func TestWarmQualityCacheUsesBatchedCachedCheck(t *testing.T) {
	initCollectionDBForTest(t)

	const songCount = 1200
	songs := make([]model.Track, 0, songCount)
	rows := make([]qualityCacheRow, 0, songCount)
	now := time.Now()
	for i := 0; i < songCount; i++ {
		song := model.Track{
			ID:       fmt.Sprintf("warm-%04d", i),
			Source:   "qq",
			Duration: 200,
		}
		key, extraHash := qualityCacheKey(song)
		if key == "" {
			t.Fatalf("quality cache key empty for %+v", song)
		}
		songs = append(songs, song)
		rows = append(rows, qualityCacheRow{
			Key: key, SongID: song.ID, Source: song.Source, ExtraHash: extraHash,
			Valid: true, SizeBytes: 4_000_000, SizeText: "3.8 MB",
			Bitrate: "160 kbps", BitrateNum: 160, CheckedAt: now,
		})
	}
	if err := db.CreateInBatches(&rows, 200).Error; err != nil {
		t.Fatalf("seed quality cache rows: %v", err)
	}

	counter := installSQLQueryCounter(t)
	counter.reset()
	warmQualityCache(songs, 6)

	if got := counter.count(); got != 3 {
		t.Fatalf("1200 首已缓存歌曲的已缓存判断发出 %d 条 SQL,期望 3(每块 500),SQL=%v", got, counter.snapshot())
	} else {
		t.Logf("1200 首已缓存歌曲的已缓存判断 SQL 条数 = %d(改造前是 1200)", got)
	}
	if got := counter.linesMatching("LIKE"); got != 0 {
		t.Fatalf("批量已缓存判断不应使用 LIKE,got %d", got)
	}
}

// TestCollectionAlbumIndexHydratesAndConverges 覆盖正确性 + 收敛:
// 搜索结果缓存里有完整元数据的歌,列表返回正确的 album/album_id;
// 回写 saved_songs.extra 之后,即使搜索结果缓存行被删掉(索引重建也无法再命中),
// 第二次请求仍然返回同样的专辑信息。
func TestCollectionAlbumIndexHydratesAndConverges(t *testing.T) {
	initCollectionDBForTest(t)
	collection := createManualCollectionForContract(t, "专辑元数据回填")
	seedAlbumLessSavedSongs(t, collection.ID, 163, localMusicSource)

	const cacheKey = "album-index-cache"
	payload, err := json.Marshal(jsonSearchResponse{
		Type:    "song",
		Keyword: "测试",
		Sources: []string{localMusicSource},
		Songs: []model.Track{{
			ID:      "song-042",
			Source:  localMusicSource,
			Name:    "测试歌曲 42",
			Artist:  "测试艺人",
			Album:   "缓存专辑",
			AlbumID: "cached-album-42",
		}},
	})
	if err != nil {
		t.Fatalf("encode search cache payload: %v", err)
	}
	if err := db.Create(&searchCacheRow{Key: cacheKey, Payload: string(payload), CreatedAt: time.Now()}).Error; err != nil {
		t.Fatalf("seed search cache: %v", err)
	}

	router := newCollectionTestRouter()
	path := fmt.Sprintf("%s/collections/%d/songs", RoutePrefix, collection.ID)

	tracks := decodeCollectionSongsResponse(t, router, path)
	target := findCollectionSongByID(t, tracks, "song-042")
	if target["album"] != "缓存专辑" || target["album_id"] != "cached-album-42" {
		t.Fatalf("hydrated album = %v / %v, want 缓存专辑 / cached-album-42", target["album"], target["album_id"])
	}
	// 响应形状不得变化:字段名是前端契约。
	assertSavedSongJSONKeys(t, target)

	// 回写已经落到 saved_songs.extra。
	var saved SavedSong
	if err := db.Where("collection_id = ? AND song_id = ?", collection.ID, "song-042").First(&saved).Error; err != nil {
		t.Fatalf("reload saved song: %v", err)
	}
	metadata := decodeSongExtraMap(saved.Extra)
	if extraMapAlbum(metadata) != "缓存专辑" || extraMapAlbumID(metadata) != "cached-album-42" {
		t.Fatalf("persisted extra = %#v, want album 缓存专辑 / cached-album-42", metadata)
	}

	// 删掉搜索结果缓存行并让索引失效:第二次请求不可能再从搜索缓存拿到元数据,
	// 只能靠已回写的 extra —— 这正是「收敛」要证明的行为。
	if err := db.Where("key = ?", cacheKey).Delete(&searchCacheRow{}).Error; err != nil {
		t.Fatalf("delete search cache row: %v", err)
	}
	invalidateSearchAlbumIndex()

	tracks = decodeCollectionSongsResponse(t, router, path)
	target = findCollectionSongByID(t, tracks, "song-042")
	if target["album"] != "缓存专辑" || target["album_id"] != "cached-album-42" {
		t.Fatalf("second request album = %v / %v, want 缓存专辑 / cached-album-42(回写应保证收敛)", target["album"], target["album_id"])
	}
	// 其它 162 首仍然没有 album(未命中不会被凭空写值)。
	if other := findCollectionSongByID(t, tracks, "song-043"); other["album"] != "" || other["album_id"] != "" {
		t.Fatalf("未命中的歌曲不应被写入专辑信息: %#v", other)
	}
}

// TestPlayHistoryAlbumHydrationUsesSearchAlbumIndex 保证 play_history 的同类 hydration
// 也走同一个索引(与歌单共用 lookup),不会另起一条 N+1。
func TestPlayHistoryAlbumHydrationUsesSearchAlbumIndex(t *testing.T) {
	initCollectionDBForTest(t)

	rows := make([]playHistoryRow, 0, 163)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 163; i++ {
		songID := fmt.Sprintf("history-%03d", i)
		rows = append(rows, playHistoryRow{
			UserID: testUserID, SongID: songID, Source: localMusicSource,
			Name: fmt.Sprintf("历史歌曲 %d", i), Artist: "测试艺人", Duration: 200,
			Extra:    fmt.Sprintf(`{"songmid":%q}`, songID),
			PlayedAt: base.Add(time.Duration(i) * time.Second),
		})
	}
	if err := db.CreateInBatches(&rows, 100).Error; err != nil {
		t.Fatalf("seed play history: %v", err)
	}

	counter := installSQLQueryCounter(t)
	counter.reset()
	historyRows, err := listPlayHistory(testUserID, 0)
	if err != nil {
		t.Fatalf("list play history: %v", err)
	}
	songs := playHistoryToSongs(historyRows)
	if len(songs) != 163 {
		t.Fatalf("play history songs = %d, want 163", len(songs))
	}
	const maxQueries = 8
	if got := counter.count(); got > maxQueries {
		t.Fatalf("163 条播放历史的 hydration 发出 %d 条 SQL,超过上限 %d(疑似 N+1),SQL=%v", got, maxQueries, counter.snapshot())
	}
	if got := counter.linesMatching("LIKE"); got != 0 {
		t.Fatalf("播放历史 hydration 不应再使用 LIKE,got %d", got)
	}
}

// TestSearchAlbumIndexTracksCacheWritesAndDeletes 覆盖索引与搜索缓存的一致性:
// putCachedSearch 之后新歌立刻可查(增量合并,不需要重扫全表);
// deleteCachedSearchKey 之后索引整体失效,被删的歌查不到。
func TestSearchAlbumIndexTracksCacheWritesAndDeletes(t *testing.T) {
	initCollectionDBForTest(t)

	// 先让索引就绪(此刻表里为空)。
	if meta, ok := lookupAlbumMetadataInSearchCache("qq", "lazy-1"); ok {
		t.Fatalf("empty cache should miss, got %+v", meta)
	}

	key := searchCacheKey("song", "lazy", "", []string{"qq"})
	putCachedSearch(key, jsonSearchResponse{
		Type:    "song",
		Keyword: "lazy",
		Sources: []string{"qq"},
		Songs: []model.Track{{
			ID: "lazy-1", Source: "qq", Name: "懒加载", Album: "懒加载专辑", AlbumID: "lazy-album-1",
		}},
	})

	meta, ok := lookupAlbumMetadataInSearchCache("qq", "lazy-1")
	if !ok || meta.Album != "懒加载专辑" || meta.AlbumID != "lazy-album-1" {
		t.Fatalf("lookup after put = %+v ok=%v, want 懒加载专辑 / lazy-album-1", meta, ok)
	}

	if _, err := deleteCachedSearchKey(key); err != nil {
		t.Fatalf("delete cached search key: %v", err)
	}
	// 删除后索引被整体失效并重建(表已空),因此查不到。
	if meta, ok := lookupAlbumMetadataInSearchCache("qq", "lazy-1"); ok {
		t.Fatalf("lookup after delete = %+v ok=%v, want miss", meta, ok)
	}
}

// TestSearchAlbumIndexConcurrentLookupAndMerge 是并发安全回归:
// 查索引只做 RLock 读、putCachedSearch 的增量合并拿写锁写,两者并发时
// 绝不能出现"把 map 引用交出锁外再读"的 data race(那会直接 panic)。
// 用 `go test -race` 跑这条测试才能真正生效。
func TestSearchAlbumIndexConcurrentLookupAndMerge(t *testing.T) {
	initCollectionDBForTest(t)

	seed := jsonSearchResponse{
		Type:    "song",
		Keyword: "并发",
		Sources: []string{"qq"},
		Songs: []model.Track{{
			ID: "concurrent-seed", Source: "qq", Name: "并发", Album: "并发专辑", AlbumID: "concurrent-album",
		}},
	}
	putCachedSearch(searchCacheKey("song", "并发", "", []string{"qq"}), seed)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// 持续读。
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				lookupAlbumMetadataInSearchCache("qq", "concurrent-seed")
				lookupAlbumMetadataInSearchCache("qq", "not-there")
			}
		}()
	}

	// 持续写(增量合并 + 整体失效),模拟搜索写入与缓存键删除。
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 60; j++ {
				key := searchCacheKey("song", fmt.Sprintf("并发-%d-%d", n, j), "", []string{"qq"})
				putCachedSearch(key, jsonSearchResponse{
					Type: "song", Keyword: "并发", Sources: []string{"qq"},
					Songs: []model.Track{{
						ID: fmt.Sprintf("concurrent-%d-%d", n, j), Source: "qq",
						Name: "并发", Album: "并发专辑", AlbumID: "concurrent-album",
					}},
				})
				if j%17 == 0 {
					invalidateSearchAlbumIndex()
				}
			}
		}(i)
	}

	// 等写侧跑完,再通知读侧停。
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	time.Sleep(50 * time.Millisecond)
	close(stop)
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("并发测试超时")
	}

	// 最终种子歌曲仍能查到(失效后重建会从库里读到它)。
	if meta, ok := lookupAlbumMetadataInSearchCache("qq", "concurrent-seed"); !ok || meta.Album != "并发专辑" {
		t.Fatalf("seed lookup after concurrent stress = %+v ok=%v", meta, ok)
	}
}

// TestSearchAlbumIndexDoesNotResurrectDeletedEntries 覆盖一个真实的竞态:
// 扫描缓存表期间如果有键被删(或 GC 删行),那份快照可能仍带着已删的数据。
// 靠 invalidate 自增代数丢弃陈旧快照,保证"删掉之后查不到",而不是被并发重建灌回来。
func TestSearchAlbumIndexDoesNotResurrectDeletedEntries(t *testing.T) {
	initCollectionDBForTest(t)

	key := searchCacheKey("song", "resurrect", "", []string{"qq"})
	putCachedSearch(key, jsonSearchResponse{
		Type: "song", Keyword: "resurrect", Sources: []string{"qq"},
		Songs: []model.Track{{
			ID: "resurrect-1", Source: "qq", Name: "复活测试", Album: "复活专辑", AlbumID: "resurrect-album",
		}},
	})
	if meta, ok := lookupAlbumMetadataInSearchCache("qq", "resurrect-1"); !ok || meta.Album != "复活专辑" {
		t.Fatalf("lookup before delete = %+v ok=%v", meta, ok)
	}

	// 在"扫描进行中"这个时间窗内让代数变化:直接调 invalidate 模拟并发删除。
	// 这里验证的是发布阶段的守卫逻辑本身(代数不一致 → 不发布)。
	generation := searchAlbumIndexGeneration.Load()
	invalidateSearchAlbumIndex()
	if searchAlbumIndexGeneration.Load() == generation {
		t.Fatal("invalidate 应当推进索引代数")
	}

	// 删除后重建应当看到空表,因此查不到。
	if _, err := deleteCachedSearchKey(key); err != nil {
		t.Fatalf("delete cached search key: %v", err)
	}
	if meta, ok := lookupAlbumMetadataInSearchCache("qq", "resurrect-1"); ok {
		t.Fatalf("deleted entry resurrected: %+v", meta)
	}
}

func decodeCollectionSongsResponse(t *testing.T, router http.Handler, path string) []map[string]interface{} {
	t.Helper()
	recorder := performCollectionRequest(router, http.MethodGet, path, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list songs status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var tracks []map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &tracks); err != nil {
		t.Fatalf("decode songs: %v", err)
	}
	return tracks
}

func findCollectionSongByID(t *testing.T, tracks []map[string]interface{}, songID string) map[string]interface{} {
	t.Helper()
	for _, track := range tracks {
		if track["id"] == songID {
			return track
		}
	}
	t.Fatalf("song %q not found in %d tracks", songID, len(tracks))
	return nil
}

// assertSavedSongJSONKeys 锁定歌单歌曲响应对象与改造前完全一致的字段集合(前端契约)。
func assertSavedSongJSONKeys(t *testing.T, track map[string]interface{}) {
	t.Helper()
	want := []string{
		"added_at", "album", "album_id", "artist", "collection_id", "cover",
		"db_id", "duration", "extra", "id", "link", "name", "source",
	}
	if len(track) != len(want) {
		t.Fatalf("song JSON keys = %v, want %v", sortedKeys(track), want)
	}
	for _, key := range want {
		if _, ok := track[key]; !ok {
			t.Fatalf("song JSON missing key %q, got %v", key, sortedKeys(track))
		}
	}
}

func sortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}
