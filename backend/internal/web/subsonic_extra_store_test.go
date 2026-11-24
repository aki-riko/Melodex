package web

// songExtraStore 的别名安全(2026-11 全库扫描补充)。
//
// 背景:get 返回的是内部 map 的**引用**(put 有 clone,get 没有)。如果调用方
// 拿到之后往 map 里写,就会污染其他并发请求读到的同一首歌的 extra,
// 且 go test -race 会报数据竞争。
//
// 本文件用真实并发复现:多个 goroutine 同时对同一首歌 get 并尝试写入,
// 断言 store 内部状态不被外部篡改。

import (
	"sync"
	"testing"
)

func TestSongExtraStoreGetReturnsIsolatedCopy(t *testing.T) {
	store := &songExtraStore{data: make(map[string]map[string]string), maxSize: 100}
	key := "qq\x00song-1"
	store.put(key, map[string]string{"quality": "flac", "bitrate": "1411"})

	// 拿到一份,改它
	first := store.get(key)
	if first == nil {
		t.Fatal("get 应返回 extra")
	}
	first["quality"] = "被外部改坏了"
	first["injected"] = "外部注入"

	// 再拿一份,必须是原始值
	second := store.get(key)
	if second == nil {
		t.Fatal("第二次 get 应返回 extra")
	}
	if second["quality"] != "flac" {
		t.Fatalf("store 内部被外部篡改: quality=%q, 期望 flac", second["quality"])
	}
	if _, exists := second["injected"]; exists {
		t.Fatalf("外部写入的键混进了 store 内部: injected=%q", second["injected"])
	}
}

func TestSongExtraStoreConcurrentGetIsRaceFree(t *testing.T) {
	store := &songExtraStore{data: make(map[string]map[string]string), maxSize: 100}
	const songs = 32
	for i := 0; i < songs; i++ {
		store.put(extraKey("qq", string(rune('a'+i%26))+string(rune('0'+i/26))), map[string]string{
			"k": "v",
		})
	}

	var wg sync.WaitGroup
	for w := 0; w < 16; w++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < songs; i++ {
				key := extraKey("qq", string(rune('a'+i%26))+string(rune('0'+i/26)))
				got := store.get(key)
				if got == nil {
					continue
				}
				// 模拟"调用方就地修改返回的 map"——正是本次要防的用法
				got["worker"] = string(rune('A' + worker%26))
			}
		}(w)
	}
	wg.Wait()
}

func TestSongExtraStorePutIsIsolatedFromCaller(t *testing.T) {
	store := &songExtraStore{data: make(map[string]map[string]string), maxSize: 100}
	source := map[string]string{"a": "1"}
	store.put("k", source)

	// 调用方改自己那份,不应影响 store
	source["a"] = "改了"
	if got := store.get("k"); got["a"] != "1" {
		t.Fatalf("put 未做隔离: got %q, 期望 1", got["a"])
	}
}
