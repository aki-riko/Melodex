package web

import "time"

const localMusicDefaultBackgroundScanEvery = 5 * time.Minute

func startBackgroundCacheMaintenance() {
	startLocalMusicBackgroundScanner()
	startSearchCacheBackgroundRefresher()
	startAPICacheBackgroundRefresher()
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
