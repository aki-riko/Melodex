package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/go-music-dl/internal/maintenance"
	"github.com/guohuiyuan/go-music-dl/internal/web"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/spf13/cobra"
)

var (
	backfillLyricsDryRun      bool
	backfillLyricsLimit       int
	backfillLyricsDelay       time.Duration
	backfillLyricsDownloadDir string
)

var backfillLyricsCmd = &cobra.Command{
	Use:   "backfill-lyrics",
	Short: "根据 download_records 为缺词的已下载歌曲生成同名 LRC",
	RunE: func(cmd *cobra.Command, args []string) error {
		core.CM.Load()
		db, err := core.OpenAppDatabase()
		if err != nil {
			return fmt.Errorf("打开数据库失败: %w", err)
		}
		if sqlDB, sqlErr := db.DB(); sqlErr == nil {
			defer sqlDB.Close()
		}

		downloadDir := strings.TrimSpace(backfillLyricsDownloadDir)
		if downloadDir == "" {
			downloadDir = core.GetWebSettings().DownloadDir
		}
		summary, err := maintenance.BackfillLyrics(cmd.Context(), db, maintenance.LyricsBackfillOptions{
			DownloadDir: downloadDir,
			DryRun:      backfillLyricsDryRun,
			Limit:       backfillLyricsLimit,
			Delay:       backfillLyricsDelay,
			Output:      cmd.OutOrStdout(),
			FetchLyric: func(_ string, song *model.Song) (string, *model.Song, error) {
				return web.LoadLyricWithFallback(song)
			},
		})
		fmt.Fprintf(cmd.OutOrStdout(), "SUMMARY dry_run=%v inspected=%d matched=%d written=%d embedded=%d sidecar=%d missing=%d invalid=%d conflict=%d unsupported=%d fetch_failed=%d write_failed=%d unusable=%d\n",
			backfillLyricsDryRun, summary.Inspected, summary.Matched, summary.Written,
			summary.ExistingEmbedded, summary.ExistingSidecar, summary.MissingFiles,
			summary.InvalidPaths, summary.Conflicts, summary.Unsupported,
			summary.FetchFailures, summary.WriteFailures, summary.UnusableLyrics)
		return err
	},
}

func init() {
	backfillLyricsCmd.Flags().BoolVar(&backfillLyricsDryRun, "dry-run", true, "仅检查并获取歌词，不写入 .lrc")
	backfillLyricsCmd.Flags().IntVar(&backfillLyricsLimit, "limit", 0, "最多检查多少个唯一文件，0 表示全部")
	backfillLyricsCmd.Flags().DurationVar(&backfillLyricsDelay, "delay", 250*time.Millisecond, "两次上游歌词请求之间的等待时间")
	backfillLyricsCmd.Flags().StringVar(&backfillLyricsDownloadDir, "download-dir", "", "下载目录覆盖值，默认读取系统设置")
	rootCmd.AddCommand(backfillLyricsCmd)
}
