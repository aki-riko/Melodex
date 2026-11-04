package web

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/bridge"
	providermodel "github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 本地库补副歌(「已下载」列表)的取舍说明
//
// 背景: `/music/local_music` 扫出来的 localMusicTrack 的 Source 恒为 "local",
// 原始平台身份在扫描阶段就丢了, 所以前端拿不到副歌点位。唯一能还原身份的地方是
// `download_records` 表(它记着 rel_path -> source + song_id)。
//
// 用户对此功能下达了**硬约束: 并发别加高**。落实到这里就是:
//   - 只对"当前页"补, 不对整库(631 条)补 —— 那是几百首量级的上游请求;
//   - 网易走一次批量接口覆盖整页, 绝不逐首;
//   - 酷我按关键词反查, 由 sidecar 串行 + 每页最多 5 首, 失败即放弃;
//   - QQ 直接跳过(没有任何接口);
//   - 本文件**不新建任何 goroutine**, 所有上游请求都在请求路径上串行发生。
//
// 缓存: 结果按 (source, song_id) 缓存 8 小时。"这首有没有副歌"几乎不变,
// 而"每次打开列表都去问一次上游"正是用户禁止的事。缓存命中时零上游请求。

const (
	// localChorusCacheTTL 是"这首歌的副歌点位"的有效期。
	// 取 8 小时: 副歌是歌曲自身的固有属性(不随会员/版权状态变化), 但也没必要永久缓存 ——
	// 万一上游早期返回过空, 8 小时后会重新问一次, 不会永久固化"这首歌没有副歌"。
	// 落在任务要求的 6~12h 区间内。
	localChorusCacheTTL = 8 * time.Hour

	// localChorusNeteaseTimeout 是网易那一路的预算。
	// 网易是一次批量请求(实测 0.2~0.6s), 3s 足够吸收偶发抖动。
	localChorusNeteaseTimeout = 3 * time.Second

	// localChorusKuwoTimeout 是酷我那一路的预算, **独立于网易**。
	//
	// 为什么必须分开(2026-11 生产实测踩过): 酷我没有"按 id 批量取副歌"的接口, 只能拿
	// 歌名+歌手反查, sidecar 内串行最多 5 首、每首一次完整搜索(实测 ~1s)。原先两路共用
	// 一个 3s ctx, 酷我必然把它吃满, 于是**排在它前面的网易结果也被一起判超时丢掉**,
	// 表现是"已下载列表里网易的歌全都没有副歌标记", 而 provider 日志明明写着命中 38/38。
	// 给酷我单独 4s(5 首串行 ~5s 的实测成本下, 拿多少算多少), 谁也别拖死谁。
	localChorusKuwoTimeout = 4 * time.Second

	// localChorusMaxNeteaseIDs 是单次批量请求的 id 上限, 与 sidecar 的 MAX_BATCH_IDS 对齐。
	// 一页最多 100 首, 所以正常永远不会触发截断; 留着是为了"上游请求规模有上界"这件事可审计。
	localChorusMaxNeteaseIDs = 100
)

// localChorusEntry 是缓存里一条副歌点位。
//
// 用"存在条目"表达"已查过", 用 point 的零值表达"查过但上游没有数据" ——
// 后者同样必须命中缓存, 否则每次翻页都会对同一批没有副歌的歌反复打上游。
type localChorusEntry struct {
	point     providermodel.ChorusPoint
	expiresAt time.Time
}

type localChorusCacheStore struct {
	mu      sync.RWMutex
	entries map[string]localChorusEntry
}

var localChorusCache = &localChorusCacheStore{entries: make(map[string]localChorusEntry)}

// chorusSourceKey 生成缓存键。带上 source 是必须的: 不同平台可能复用同一串数字 id,
// 只用 song_id 会把酷我的点位错标到网易的歌上。
func chorusSourceKey(source, songID string) string {
	return strings.ToLower(strings.TrimSpace(source)) + "\x00" + strings.TrimSpace(songID)
}

func (store *localChorusCacheStore) load(source, songID string) (providermodel.ChorusPoint, bool) {
	key := chorusSourceKey(source, songID)
	store.mu.RLock()
	entry, ok := store.entries[key]
	store.mu.RUnlock()
	if !ok {
		return providermodel.ChorusPoint{}, false
	}
	if time.Now().After(entry.expiresAt) {
		store.mu.Lock()
		delete(store.entries, key)
		store.mu.Unlock()
		return providermodel.ChorusPoint{}, false
	}
	return entry.point, true
}

func (store *localChorusCacheStore) store(source, songID string, point providermodel.ChorusPoint) {
	store.mu.Lock()
	store.entries[chorusSourceKey(source, songID)] = localChorusEntry{
		point: point, expiresAt: time.Now().Add(localChorusCacheTTL),
	}
	store.mu.Unlock()
}

// resetLocalChorusCacheForTest 清空副歌缓存。
//
// 测试必须能清: 缓存是包级全局, 上一个用例塞进去的"已查过"会让下一个用例
// 在断言"上游被调用了几次"时看到 0 次, 得到一个假绿的测试。
func resetLocalChorusCacheForTest() {
	localChorusCache.mu.Lock()
	localChorusCache.entries = make(map[string]localChorusEntry)
	localChorusCache.mu.Unlock()
}

// localChorusFetchFunc 是「按源取一批副歌点位」的函数签名。
type localChorusFetchFunc func(context.Context, bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error)

// localChorusFetchProvider 是上游调用的注入点(默认走 Provider sidecar)。
//
// 之所以做成包级变量: 单测要能断言"调用次数"来证明缓存命中时零上游请求、
// 以及上游失败时列表照常返回。直接打真实 sidecar 会让这两条断言都变成
// 依赖网络与耗时的脆弱测试, 与 AGENTS.md 的纪律相悖。
var localChorusFetchProvider = func(source string) localChorusFetchFunc {
	return func(ctx context.Context, request bridge.ChorusRequest) (map[string]providermodel.ChorusPoint, error) {
		client, err := core.NewProviderBridgeClient()
		if err != nil {
			return nil, err
		}
		return client.Chorus(ctx, request)
	}
}

// localChorusCookieProvider 是平台凭证的注入点(测试里置空即可完全脱网)。
var localChorusCookieProvider = core.CookieForSource

// localTrackOrigin 是一条本地曲目还原出来的原始平台身份。
type localTrackOrigin struct {
	Source string
	SongID string
	Name   string
	Artist string
}

// localChorusFillableSource 判断某个源是否值得为它发起上游请求。
//
// 只放行网易与酷我:
//   - 网易有官方批量接口, 一次请求覆盖整页, 是主力覆盖(生产 631 条里 126 条);
//   - 酷我只能关键词反查, 由 sidecar 严格串行限流(生产 26 条);
//   - QQ 没有任何可用接口(实测多个模块 500003), 连试都不试(生产 458 条, 最该省);
//   - soda/kugou/migu/qianqian 同样没有副歌接口。
//
// 把白名单写死在这里, 是为了"上游请求只可能发向确实有接口的源"有一个单点可审计。
func localChorusFillableSource(source string) bool {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "netease", "kuwo":
		return true
	default:
		return false
	}
}

// fillChorusForTracks 给一批**已有源身份**的歌曲补副歌点位(原地改 extra)。
//
// 与 fillLocalChorusForPage 的区别: 那条路要先从 download_records 还原身份(因为本地
// 扫描出来的 Source 恒为 "local"); 这条路手上的歌已经带着真实 (source, song_id) ——
// 比如「最近播放」的 play_history_rows、歌单的 saved_songs, 直接按身份查即可。
//
// 为什么要单独做(2026-11 生产反馈): 用户从「最近播放」点开一首网易歌, 进度条上没有
// 副歌标记 —— 那些行的 extra 是**播放当时**的快照, 里面根本没有 chorus_*, 而当时
// 只给「已下载」列表做了回填。展示层拿到的既然是旧快照, 就得在读取时补, 而不是指望
// 历史行自己长出字段。
//
// 并发纪律不变: 不启 goroutine, 网易一次批量, 酷我串行 ≤5 首, 每源独立超时。
func fillChorusForTracks(entries []chorusIdentity) map[string]providermodel.ChorusPoint {
	if len(entries) == 0 {
		return nil
	}
	// 去重 + 白名单过滤, 得到"值得问上游且还没查过"的身份。
	missing := make(map[string]localTrackOrigin, len(entries))
	for _, entry := range entries {
		source := strings.ToLower(strings.TrimSpace(entry.Source))
		songID := strings.TrimSpace(entry.SongID)
		if source == "" || songID == "" || !localChorusFillableSource(source) {
			continue
		}
		if _, hit := localChorusCache.load(source, songID); hit {
			continue
		}
		key := chorusSourceKey(source, songID)
		if _, ok := missing[key]; ok {
			continue
		}
		missing[key] = localTrackOrigin{
			Source: source, SongID: songID, Name: entry.Name, Artist: entry.Artist,
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return fetchLocalChorusUpstream(missing)
}

// chorusIdentity 是一个"已知平台身份"的歌, 用来按身份补副歌。
type chorusIdentity struct {
	Source string
	SongID string
	Name   string
	Artist string
}

// trackChorusIdentities 把一批 model.Track 转成补副歌用的身份列表。
//
// 抽出来是为了让所有"返回歌给前端"的地方都用同一套写法 —— 少一处手写 to-identity
// 就少一个可能漏掉副歌的入口(2026-11 就是因为逐个手写, 漏了导入歌单与平台详情)。
func trackChorusIdentities(tracks []providermodel.Track) []chorusIdentity {
	identities := make([]chorusIdentity, 0, len(tracks))
	for i := range tracks {
		identities = append(identities, chorusIdentity{
			Source: tracks[i].Source, SongID: tracks[i].ID,
			Name: tracks[i].Name, Artist: tracks[i].Artist,
		})
	}
	return identities
}

// applyChorusToExtraMap 把副歌点位写进一个 extra map(供 gin.H 响应用)。
//
// 与 writeLocalChorusExtra 同口径: 键名必须与前端 playerChorus.mjs 消费的一致,
// 且两个都必须有值 —— 缺一边前端就不画标记。
func applyChorusToExtraMap(extra map[string]string, point providermodel.ChorusPoint) {
	if extra == nil || !point.Valid() {
		return
	}
	extra["chorus_start_ms"] = strconv.FormatInt(int64(point.Start), 10)
	extra["chorus_end_ms"] = strconv.FormatInt(int64(point.End), 10)
}

// chorusPointFor 按 (source, song_id) 取副歌点位: 先缓存, 缓存没有再走 fillChorusForTracks。
// 供"单首已知身份"的场景使用(避免调用方自己拼 map)。
func chorusPointFor(source, songID, name, artist string) providermodel.ChorusPoint {
	source = strings.ToLower(strings.TrimSpace(source))
	songID = strings.TrimSpace(songID)
	if source == "" || songID == "" || !localChorusFillableSource(source) {
		return providermodel.ChorusPoint{}
	}
	if point, hit := localChorusCache.load(source, songID); hit {
		return point
	}
	fetched := fillChorusForTracks([]chorusIdentity{{Source: source, SongID: songID, Name: name, Artist: artist}})
	return fetched[chorusSourceKey(source, songID)]
}

// fillLocalChorusForPage 为当前页的本地曲目补副歌点位(原地修改 track.Extra)。
//
// 调用方必须在 paginate 之后调用: 只处理当前页(前端每页 100 首), 而不是整库。
// 整库 631 首里有 458 首来自 QQ(没接口), 剩下的也远超"一次列表刷新该打的上游量"。
//
// 严格遵守"并发别加高": 不启动 goroutine, 网易一次批量, 酷我 sidecar 串行最多 5 首,
// 整体 3s 超时。失败一律静默降级 —— 拿不到副歌只是少一个进度条标记。
func fillLocalChorusForPage(tracks []*localMusicTrack) {
	if len(tracks) == 0 {
		return
	}
	origins := resolveLocalChorusOrigins(tracks)
	if len(origins) == 0 {
		return
	}
	applyLocalChorusPoints(tracks, origins, nil)

	// 只对缓存未命中的歌发起上游请求。同一页第二次刷新时, 这里通常是空的。
	missing := missingLocalChorusOrigins(origins)
	if len(missing) == 0 {
		return
	}
	fetched := fetchLocalChorusUpstream(missing)
	// 把刚拿到的点位应用到本页。缓存里已有的不需要重放 —— applyLocalChorusPoints
	// 在发起上游之前已经写过一次了。
	applyLocalChorusPoints(tracks, origins, fetched)
}

// resolveLocalChorusOrigins 把本地曲目的 rel_path 关联回 download_records 的原始身份。
//
// 关联键必须用 rel_path: localMusicTrack.RelPath 与 DownloadRecord.RelPath 是同一口径
// (相对下载目录的规范化路径)。不能退化成按歌名/歌手匹配 —— 同名的原唱、伴奏、Live
// 会被串成同一首, 把副歌点位标到错的歌上。
func resolveLocalChorusOrigins(tracks []*localMusicTrack) map[string]localTrackOrigin {
	if db == nil {
		return nil
	}
	paths := make([]string, 0, len(tracks))
	wanted := make(map[string]struct{}, len(tracks))
	for _, track := range tracks {
		if track == nil {
			continue
		}
		rel := normalizeRelPath(track.RelPath)
		if rel == "" {
			continue
		}
		if _, ok := wanted[rel]; ok {
			continue
		}
		wanted[rel] = struct{}{}
		paths = append(paths, rel)
	}
	if len(paths) == 0 {
		return nil
	}

	var records []DownloadRecord
	// 一条 rel_path 可能对应多个用户的归属记录, 但来源身份是同一个。
	// IN 查询一次拿回, 不做逐首点查(那会变成 100 条 SQL, 正是 AGENTS.md 里 N+1 的反面教材)。
	if err := db.Where("rel_path IN ?", paths).Find(&records).Error; err != nil {
		log.Printf("[local_chorus] 读取下载归属失败: %v", err)
		return nil
	}

	origins := make(map[string]localTrackOrigin, len(records))
	for _, record := range records {
		rel := normalizeRelPath(record.RelPath)
		if _, ok := wanted[rel]; !ok {
			continue
		}
		source := strings.ToLower(strings.TrimSpace(record.Source))
		songID := strings.TrimSpace(record.SongID)
		if source == "" || songID == "" {
			continue
		}
		// 只保留首个: 同一 rel_path 的多条记录描述的是同一份文件, 取哪条都一样,
		// 但显式跳过能让行为确定。
		if _, ok := origins[rel]; ok {
			continue
		}
		origins[rel] = localTrackOrigin{
			Source: source,
			SongID: songID,
			Name:   strings.TrimSpace(record.Name),
			Artist: strings.TrimSpace(record.Artist),
		}
	}
	return origins
}

// applyLocalChorusPoints 把点位写进曲目的 Extra。
//
// fetched 为 nil 时表示"只用缓存"; 非 nil 时优先用 fetched(本次上游结果),
// 未命中的回落到缓存。这样调用方不必关心点位来自哪一路。
func applyLocalChorusPoints(
	tracks []*localMusicTrack,
	origins map[string]localTrackOrigin,
	fetched map[string]providermodel.ChorusPoint,
) {
	for _, track := range tracks {
		if track == nil {
			continue
		}
		origin, ok := origins[normalizeRelPath(track.RelPath)]
		if !ok {
			continue
		}
		key := chorusSourceKey(origin.Source, origin.SongID)
		if fetched != nil {
			if point, ok := fetched[key]; ok {
				if point.Valid() {
					writeLocalChorusExtra(track, point)
				}
				continue
			}
		}
		if point, hit := localChorusCache.load(origin.Source, origin.SongID); hit {
			writeLocalChorusExtra(track, point)
		}
	}
}

// missingLocalChorusOrigins 挑出"值得问上游且还没查过"的身份。
//
// 去重按 (source, song_id): 同一首歌可能因音质升级留下多条 rel_path 记录,
// 问一次就够了。返回的键是 chorusSourceKey。
func missingLocalChorusOrigins(origins map[string]localTrackOrigin) map[string]localTrackOrigin {
	missing := make(map[string]localTrackOrigin)
	for _, origin := range origins {
		if !localChorusFillableSource(origin.Source) {
			continue
		}
		if _, hit := localChorusCache.load(origin.Source, origin.SongID); hit {
			continue
		}
		key := chorusSourceKey(origin.Source, origin.SongID)
		if _, ok := missing[key]; ok {
			continue
		}
		missing[key] = origin
	}
	return missing
}

// fetchLocalChorusUpstream 按源聚合后逐个源**串行**请求, 返回 (source,song_id) -> 点位。
//
// 串行而不是并发: 网易与酷我加起来最多两次上游交互(网易 1 次批量、酷我最坏 5 次
// 串行反查, 后者发生在 sidecar 内部)。这个量级不需要并发, 并发只会让
// "并发别加高"这条约束更难审计。
//
// **每个源各给一份独立预算**(2026-11 修): 之前是所有源共用同一个 3s ctx, 结果
// 酷我串行反查 5 首(每首一次完整搜索,实测每首 ~1s)必然吃满预算, 让排在后面的源
// 全部拿不到时间。现在网易 3s(批量,实测 0.2~0.6s 足够)、酷我单独 4s。
// 总时长仍有上界(≤7s), 但**没有一个源能拖死另一个**。
// 顺序仍是网易优先: 它是主力覆盖(126/631), 先把这份稳的拿到手。
func fetchLocalChorusUpstream(missing map[string]localTrackOrigin) map[string]providermodel.ChorusPoint {
	bySource := make(map[string][]localTrackOrigin, 2)
	for _, origin := range missing {
		bySource[origin.Source] = append(bySource[origin.Source], origin)
	}

	result := make(map[string]providermodel.ChorusPoint, len(missing))
	// 固定顺序遍历(网易优先), 每个源用自己那份超时。
	for _, entry := range []struct {
		source  string
		timeout time.Duration
	}{
		{"netease", localChorusNeteaseTimeout},
		{"kuwo", localChorusKuwoTimeout},
	} {
		origins := bySource[entry.source]
		if len(origins) == 0 {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), entry.timeout)
		for key, point := range fetchChorusForSource(ctx, entry.source, origins) {
			result[key] = point
		}
		cancel()
	}
	return result
}

// fetchChorusForSource 为单个源发起上游请求, 并把结果(含"没有")写进缓存。
func fetchChorusForSource(
	ctx context.Context,
	source string,
	origins []localTrackOrigin,
) map[string]providermodel.ChorusPoint {
	fetch := localChorusFetchProvider(source)
	if fetch == nil {
		return nil
	}

	ids := make([]string, 0, len(origins))
	hints := make(map[string]string, len(origins))
	for _, origin := range origins {
		ids = append(ids, origin.SongID)
		// 酷我只能关键词反查, sidecar 需要歌名/歌手; 网易不用这个字段。
		if source == "kuwo" {
			hints[origin.SongID] = strings.TrimSpace(origin.Name + " " + origin.Artist)
		}
	}
	if source == "netease" && len(ids) > localChorusMaxNeteaseIDs {
		ids = ids[:localChorusMaxNeteaseIDs]
	}
	if len(ids) == 0 {
		return nil
	}

	// 单个源的失败绝不外溢: 网易挂了不应该连带酷我也不补。
	points, err := fetch(ctx, bridge.ChorusRequest{
		Source: source, IDs: ids, Cookie: localChorusCookieProvider(source), KuwoHints: hints,
	})
	if err != nil {
		log.Printf("[local_chorus] %s 取副歌失败(%d 首): %v", source, len(ids), err)
	}

	// 只在"这次请求本身没有拿到任何结果"时才放弃回填。
	//
	// **曾经这里是 `if ctx.Err() != nil { return nil }`, 那是个真 bug(2026-11 生产实测)**:
	// 网易先跑完、38/38 首点位都拿到了, 随后酷我反查把 3s 总预算耗尽 → ctx.Err() 非空 →
	// 这个函数直接返回 nil, 把**已经到手的网易结果整批丢掉**。表现就是"已下载列表里
	// 网易的歌一个副歌标记都没有", 而 provider 日志明明写着"命中 38/38"。
	// 正确判据是"这一路有没有真的拿到数据", 而不是"整页的总预算是否还活着":
	// 拿到了就照常回填(它已经付过代价了), 没拿到才当失败。
	if len(points) == 0 && ctx.Err() != nil {
		return nil
	}

	result := make(map[string]providermodel.ChorusPoint, len(points))
	for _, id := range ids {
		key := chorusSourceKey(source, id)
		point, ok := points[id]
		if ok && point.Valid() {
			localChorusCache.store(source, id, point)
			result[key] = point
			continue
		}
		// 上游明确没给这首: 缓存零值, 表示"查过、没有"。
		localChorusCache.store(source, id, providermodel.ChorusPoint{})
	}
	return result
}

// writeLocalChorusExtra 把副歌点位写进曲目的 Extra。
//
// 键名必须与前端 playerChorus.mjs 消费的一致(chorus_start_ms / chorus_end_ms),
// 且**两个都必须是真值** —— 缺一边前端就不画标记。零值点位(查过但没有)什么都不写。
func writeLocalChorusExtra(track *localMusicTrack, point providermodel.ChorusPoint) {
	if track == nil || !point.Valid() {
		return
	}
	if track.Extra == nil {
		track.Extra = make(map[string]string, 2)
	}
	track.Extra["chorus_start_ms"] = fmt.Sprintf("%d", point.Start)
	track.Extra["chorus_end_ms"] = fmt.Sprintf("%d", point.End)
}
