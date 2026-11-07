package web

import (
	"errors"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 歌单预热必须把歌名/歌手带进 model.Track。
//
// 2026-11 真实事故的起点就在这里: collectionSongsJSON 构造 warmTracks 时只塞了
// ID/Source/Duration, 于是预热拿到的是"没有歌名的歌" → 取址时兜底搜索词退化成纯数字
// 歌曲 ID(core.resolveProviderSong 当年还有 `keyword = song.ID` 这一行) → 打开几个
// 歌单就连发 79 次"拿数字当关键词"的网易搜索 → 网易 code=405 全域限流 →
// 「腐草为萤」播放 502, 界面只显示含糊的"音频源暂时不可用"。
//
// 这条测试走**真实路径**: 直接调 collectionSongsJSON, 用 qualityDownloadURLProvider
// 拦截后台预热实际拿到的曲目。桩直接报错, 预热拿到曲目就会走到它, 且不会打网络。
func TestCollectionSongsWarmTracksCarryNameAndArtist(t *testing.T) {
	initCollectionDBForTest(t)

	collection := Collection{
		UserID: testUserID, Name: "网易歌单", Kind: collectionKindManual,
		ContentType: collectionContentPlaylist, Source: localMusicSource,
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatal(err)
	}
	added, err := saveSongsToManualCollection(collection.ID, []model.Track{{
		ID: "28188426", Source: "netease", Name: "腐草为萤", Artist: "银临",
		Duration: 280,
	}})
	if err != nil || added != 1 {
		t.Fatalf("save song: added=%d err=%v", added, err)
	}

	// 预热在后台 goroutine 里跑, 用带缓冲的 channel 回收它看到的曲目。
	seen := make(chan model.Track, 8)
	origProvider := qualityDownloadURLProvider
	qualityDownloadURLProvider = func(song model.Track) (string, error) {
		select {
		case seen <- song:
		default:
		}
		return "", errors.New("stub: no media in test")
	}
	t.Cleanup(func() { qualityDownloadURLProvider = origProvider })

	if _, err := collectionSongsJSON(&collection); err != nil {
		t.Fatalf("collectionSongsJSON: %v", err)
	}

	var got model.Track
	select {
	case got = <-seen:
	case <-time.After(5 * time.Second):
		t.Fatal("后台预热没有探测任何曲目 —— 这条断言依赖预热真的跑起来")
	}

	if got.Name != "腐草为萤" || got.Artist != "银临" {
		t.Fatalf(
			"预热曲目缺少歌名/歌手: name=%q artist=%q —— 下游会退化成用歌曲 ID 当搜索词",
			got.Name, got.Artist,
		)
	}
	// 顺带锁住"ID 仍然在": 去掉它会让缓存键和取址都失效。
	if got.ID != "28188426" || got.Source != "netease" {
		t.Fatalf("预热曲目身份丢失: id=%q source=%q", got.ID, got.Source)
	}
}
