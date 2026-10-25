package web

import "time"

const localMusicDefaultBackgroundScanEvery = 5 * time.Minute

func startBackgroundCacheMaintenance() {
	startLocalMusicBackgroundScanner()
	startSearchCacheBackgroundRefresher()
	startAPICacheBackgroundRefresher()
	// 搜索引擎的专辑索引只读 search_cache_rows,启动后异步预建一次:
	// 部署/重启后的第一次「我的歌单」因此也不用承担那次流式扫表的成本。
	warmSearchAlbumIndexAsync()
}

func startLocalMusicBackgroundScanner() {
	interval := durationFromEnv("MUSIC_DL_LOCAL_MUSIC_SCAN_INTERVAL", localMusicDefaultBackgroundScanEvery)
	if interval <= 0 {
		return
	}
	go func() {
		refreshLocalMusicScanAsync(localMusicDownloadDir())
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			refreshLocalMusicScanAsync(localMusicDownloadDir())
		}
	}()
}

func startSearchCacheBackgroundRefresher() {
	interval := searchCacheRefreshEvery()
	if interval <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			refreshStaleSearchCacheRows(searchCacheBackgroundRefreshRows)
		}
	}()
}

func startAPICacheBackgroundRefresher() {
	interval := apiCacheRefreshEvery()
	if interval <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			refreshStaleAPICacheRows(apiCacheBackgroundRefreshRows)
		}
	}()
}
