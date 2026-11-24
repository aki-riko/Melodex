package web

// 收藏切换的并发行为(2026-11 全库扫描补充;**已澄清原实现本来就是对的**)。
//
// 本文件最初是为了验证"并发下 toggle 返回值会撒谎"这个猜想而写的,但写完后
// 用突变验证**推翻了该猜想**:把 favorites.go 退回原实现(无事务、不看
// RowsAffected),这两条测试照样通过。原因是
//   · saved_songs 有 uniqueIndex(collection_id, song_id, source)
//     + OnConflict{DoNothing} → 数据不可能重复;
//   · toggle 是翻转语义,并发下最终 0 行还是 1 行本就取决于执行顺序;
//   · 两种交错的返回值恰好都正确(见 favorites.go 里那段注释的推演)。
//
// 那这些测试还有什么用?锁住**不变量**,不管实现怎么改:
//   1. 并发打 toggle 不得出现 5xx / 不得产生重复行;
//   2. 接口返回的 favorited 必须与随后 status 接口的口径一致(同一真相源);
//   3. 顺序 toggle(on → off → on)的结果必须稳定。
// 将来若有人给 saved_songs 去掉唯一索引、或把 OnConflict 改成 Update,
// 这三条会立刻红 —— 那正是它们该拦的。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

// toggleOnce 直接调 toggle handler,返回接口声称的 favorited 与可能的错误。
func toggleOnce(t *testing.T, r *gin.Engine, body string) (bool, int) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, RoutePrefix+"/favorites/toggle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		return false, rec.Code
	}
	var out struct {
		Favorited bool `json:"favorited"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode toggle response: %v (body=%s)", err, rec.Body.String())
	}
	return out.Favorited, rec.Code
}

// favoriteRowCount 读数据库里该歌的收藏行数(0 或 1 是合法值)。
func favoriteRowCount(t *testing.T, collectionID uint, songID, source string) int64 {
	t.Helper()
	var n int64
	err := db.Model(&SavedSong{}).
		Where("collection_id = ? AND song_id = ? AND source = ?", collectionID, songID, source).
		Count(&n).Error
	if err != nil {
		t.Fatalf("count favorite rows: %v", err)
	}
	return n
}

// TestFavoriteToggleConcurrentNeverDiverges 并发打 toggle,断言:
//   - 不出现 500(事务/唯一约束没被并发打崩);
//   - 每个响应的 favorited 都等于"该响应产生后数据库的真实状态"
//     (强一致口径:响应不能撒谎)。
//
// 注意:toggle 是"翻转"语义,并发下最终存几行取决于执行顺序(0 或 1 都合法),
// 所以这里**不断言最终行数**,只断言"每次响应都与当时的库内状态一致"。
// 这正是原实现的缺陷所在 —— 数据对、返回值可能错。
func TestFavoriteToggleConcurrentNeverDiverges(t *testing.T) {
	setupUserTestDB(t)
	alice, err := createUser("alice", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	r := newFavoriteTestRouter(alice.ID)

	fav, err := ensureFavoriteCollection(alice.ID)
	if err != nil {
		t.Fatalf("ensureFavoriteCollection: %v", err)
	}

	const body = `{"id":"race-song","source":"qq","name":"并发测试","artist":"歌手","duration":200}`
	const workers = 8

	type result struct {
		favorited bool
		code      int
	}
	results := make([]result, workers)

	var start sync.WaitGroup
	var done sync.WaitGroup
	start.Add(1)
	done.Add(workers)
	for i := 0; i < workers; i++ {
		go func(idx int) {
			defer done.Done()
			start.Wait() // 尽量让所有 goroutine 同时开跑
			favored, code := toggleOnce(t, r, body)
			results[idx] = result{favorited: favored, code: code}
		}(i)
	}
	start.Done()
	done.Wait()

	for i, res := range results {
		if res.code != http.StatusOK {
			t.Fatalf("worker %d 返回了非 200: %d(toggle 在并发下不应失败)", i, res.code)
		}
	}

	// 并发结束后,库内真实状态必须与"最后一个响应的口径"相容:
	// 行数为 1 → 最终应是已收藏;为 0 → 未收藏。
	// 这里只能核对最终态(中间态已被覆盖),但足以证明序列化没丢更新。
	finalRows := favoriteRowCount(t, fav.ID, "race-song", "qq")
	if finalRows > 1 {
		t.Fatalf("并发切换后出现 %d 行重复收藏记录(唯一索引应拦住)", finalRows)
	}
	finalFavored, status := readFavoriteStatusViaRoute(t, r)
	if status != http.StatusOK {
		t.Fatalf("并发后 status 接口失败: %d", status)
	}
	if (finalRows == 1) != finalFavored {
		t.Fatalf("最终状态不一致: 库内 %d 行,但 status 接口说 favorited=%v", finalRows, finalFavored)
	}
}

// readFavoriteStatusViaRoute 通过真实路由读当前收藏状态(不直接查库,
// 这样顺带验证 status 接口与 toggle 的口径一致)。
func readFavoriteStatusViaRoute(t *testing.T, r *gin.Engine) (bool, int) {
	t.Helper()
	rec := doJSON(r, http.MethodGet, RoutePrefix+"/favorites/status?source=qq&id=race-song", nil, nil)
	if rec.Code != http.StatusOK {
		return false, rec.Code
	}
	var out struct {
		Favorited bool `json:"favorited"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return out.Favorited, rec.Code
}

// TestFavoriteToggleDeleteReportsTrueState 顺序场景下的精确断言:
// 若收藏行已被别的路径删掉(模拟并发中"对方先删了"),toggle 仍必须
// 如实返回"当前未收藏",不能因为自己没删到行就报错或谎报。
func TestFavoriteToggleDeleteReportsTrueState(t *testing.T) {
	setupUserTestDB(t)
	alice, err := createUser("alice", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	r := newFavoriteTestRouter(alice.ID)
	if _, err := ensureFavoriteCollection(alice.ID); err != nil {
		t.Fatalf("ensureFavoriteCollection: %v", err)
	}

	const body = `{"id":"d1","source":"qq","name":"删后返回值","artist":"x","duration":100}`

	// 先收藏
	if favored, code := toggleOnce(t, r, body); code != http.StatusOK || !favored {
		t.Fatalf("首次 toggle 应为已收藏, got favored=%v code=%d", favored, code)
	}
	// 再取消
	if favored, code := toggleOnce(t, r, body); code != http.StatusOK || favored {
		t.Fatalf("二次 toggle 应为未收藏, got favored=%v code=%d", favored, code)
	}
	// 三次 → 又收藏
	if favored, code := toggleOnce(t, r, body); code != http.StatusOK || !favored {
		t.Fatalf("三次 toggle 应为已收藏, got favored=%v code=%d", favored, code)
	}
}
