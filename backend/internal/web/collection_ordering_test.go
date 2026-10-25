package web

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 「我喜欢」必须始终排在歌单列表第一位。
//
// 真实问题:列表原按 `id DESC` 排,而「我喜欢」是注册时为每个用户预建的(id 最小),
// 于是用户每新建一个歌单就被往后挤一位 —— 建 6 个后它排到第 7,用户会以为"我喜欢没了"。
// 收藏是高频动作,入口必须固定。这条测试防的是"以后有人把排序改回去"。
func TestFavoriteCollectionAlwaysFirstInListing(t *testing.T) {
	initCollectionDBForTest(t)

	// 关键:先建 favorite(id 最小),再建一批 manual(id 更大)。
	// 如果按 id DESC 排,favorite 必然垫底 —— 正是线上出现的现象。
	favorite, err := ensureFavoriteCollection(testUserID)
	if err != nil {
		t.Fatalf("ensure favorite collection: %v", err)
	}
	manualNames := []string{"永夜星河", "日语歌曲", "纯音乐", "流行歌曲", "古风歌曲", "可塑性记忆"}
	for _, name := range manualNames {
		createManualCollectionForContract(t, name)
	}

	router := newCollectionTestRouter()
	recorder := performCollectionRequest(router, http.MethodGet, RoutePrefix+"/collections", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list collections status = %d, want 200", recorder.Code)
	}
	var listed []Collection
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode collections: %v", err)
	}
	if len(listed) != len(manualNames)+1 {
		t.Fatalf("listed %d collections, want %d", len(listed), len(manualNames)+1)
	}

	// 1) 第一条必须是 favorite
	if listed[0].Kind != collectionKindFavorite {
		t.Fatalf("first collection kind = %q, want %q (「我喜欢」必须置顶)",
			listed[0].Kind, collectionKindFavorite)
	}
	if listed[0].ID != favorite.ID {
		t.Fatalf("first collection id = %d, want favorite id %d", listed[0].ID, favorite.ID)
	}

	// 2) favorite 只能出现一次且必须是唯一位于最前的
	for i, c := range listed {
		if c.Kind == collectionKindFavorite && i != 0 {
			t.Fatalf("favorite collection at index %d, want only index 0", i)
		}
	}

	// 3) 其余保持 id 倒序(新建的在前)—— 排序规则不能被顺手改掉
	for i := 1; i < len(listed)-1; i++ {
		if listed[i].ID < listed[i+1].ID {
			t.Fatalf("manual collections not in id DESC order at index %d: %d then %d",
				i, listed[i].ID, listed[i+1].ID)
		}
	}
}

// include_imported=1 时,imported 歌单也参与列表;favorite 仍必须置顶。
// (这是侧栏「我的歌单」的实际请求方式 —— CollectionsContext 带 include_imported=1,
//  否则从平台导入的引用型歌单不显示。所以这是最贴近真实路径的一条。)
func TestFavoriteStaysFirstWithImportedCollections(t *testing.T) {
	initCollectionDBForTest(t)
	favorite, err := ensureFavoriteCollection(testUserID)
	if err != nil {
		t.Fatalf("ensure favorite: %v", err)
	}
	createManualCollectionForContract(t, "自建一")
	imported := Collection{
		UserID: testUserID, Name: "平台导入", Kind: collectionKindImported,
		ContentType: collectionContentPlaylist, Source: "netease", ExternalID: "pl-1",
	}
	if err := db.Create(&imported).Error; err != nil {
		t.Fatalf("seed imported: %v", err)
	}
	createManualCollectionForContract(t, "自建二")

	router := newCollectionTestRouter()
	recorder := performCollectionRequest(
		router, http.MethodGet, RoutePrefix+"/collections?include_imported=1", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	var listed []Collection
	if err := json.Unmarshal(recorder.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(listed) != 4 {
		t.Fatalf("listed %d, want 4 (favorite + 2 manual + 1 imported)", len(listed))
	}
	if listed[0].Kind != collectionKindFavorite || listed[0].ID != favorite.ID {
		t.Fatalf("first should be favorite (id=%d kind=%q), got id=%d kind=%q",
			favorite.ID, collectionKindFavorite, listed[0].ID, listed[0].Kind)
	}
	// imported 也应按 id 倒序参与后半段排序,不能被特殊对待
	for i := 1; i < len(listed)-1; i++ {
		if listed[i].ID < listed[i+1].ID {
			t.Fatalf("non-favorite collections not in id DESC at index %d", i)
		}
	}
}
