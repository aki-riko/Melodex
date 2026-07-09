package core

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func TestBuildDownloadFilenameUsesTemplate(t *testing.T) {
	song := &model.Song{
		ID:     "12345",
		Source: "netease",
		Name:   "没地址的信",
		Artist: "阮俊霖",
		Album:  "专辑/测试",
	}

	tests := []struct {
		name     string
		template string
		ext      string
		want     string
	}{
		{
			name:     "default template appends extension",
			template: "",
			ext:      "mp3",
			want:     "没地址的信 - 阮俊霖.mp3",
		},
		{
			name:     "custom template can create subdirectories",
			template: "{artist}/{album}/{name}",
			ext:      "flac",
			want:     filepath.Join("阮俊霖", "专辑_测试", "没地址的信.flac"),
		},
		{
			name:     "extension token controls extension position in subdirectory template",
			template: "{artist}/{album}/{name} - {artist}.{ext}",
			ext:      "flac",
			want:     filepath.Join("阮俊霖", "专辑_测试", "没地址的信 - 阮俊霖.flac"),
		},
		{
			name:     "path traversal segments are ignored",
			template: "../{artist}/./{name}.{ext}",
			ext:      "m4a",
			want:     filepath.Join("阮俊霖", "没地址的信.m4a"),
		},
		{
			name:     "flat template still works",
			template: "{source}-{id}-{name}.{ext}",
			ext:      "m4a",
			want:     "netease-12345-没地址的信.m4a",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := BuildDownloadFilename(song, tt.ext, tt.template); got != tt.want {
				t.Fatalf("BuildDownloadFilename() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSaveDownloadedSongToFileCreatesTemplateSubdirectories(t *testing.T) {
	dir := t.TempDir()
	result := &DownloadedSong{
		Data:     []byte("audio"),
		Filename: filepath.Join("阮俊霖", "专辑", "没地址的信.flac"),
	}

	saved, err := saveDownloadedSongToFile(result, dir)
	if err != nil {
		t.Fatal(err)
	}

	wantPath := filepath.Join(dir, "阮俊霖", "专辑", "没地址的信.flac")
	if saved.SavedPath != wantPath {
		t.Fatalf("SavedPath = %q, want %q", saved.SavedPath, wantPath)
	}
	data, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "audio" {
		t.Fatalf("saved data = %q, want audio", string(data))
	}
}

// 已存在同名的更高音质(flac)时,新的低音质(mp3)应跳过写入并复用 flac。
func TestSaveDownloadedSongSkipsWhenHigherQualityExists(t *testing.T) {
	dir := t.TempDir()
	flacPath := filepath.Join(dir, "歌名 - 歌手.flac")
	if err := os.WriteFile(flacPath, []byte("flac-data"), 0644); err != nil {
		t.Fatal(err)
	}

	result := &DownloadedSong{
		Data:     []byte("mp3-data"),
		Ext:      "mp3",
		Filename: "歌名 - 歌手.mp3",
	}
	saved, err := saveDownloadedSongToFile(result, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.Skipped {
		t.Fatalf("Skipped = false, want true(已有 flac 应跳过 mp3)")
	}
	if saved.SavedPath != flacPath {
		t.Fatalf("SavedPath = %q, want %q(应复用已存在 flac)", saved.SavedPath, flacPath)
	}
	if _, err := os.Stat(filepath.Join(dir, "歌名 - 歌手.mp3")); !os.IsNotExist(err) {
		t.Fatalf("mp3 不应被写入")
	}
}

// 已存在同名的更低音质(mp3)时,新的更高音质(flac)应写入并删除旧 mp3。
func TestSaveDownloadedSongUpgradesQualityAndRemovesOld(t *testing.T) {
	dir := t.TempDir()
	mp3Path := filepath.Join(dir, "歌名 - 歌手.mp3")
	if err := os.WriteFile(mp3Path, []byte("mp3-data"), 0644); err != nil {
		t.Fatal(err)
	}

	result := &DownloadedSong{
		Data:     []byte("flac-data"),
		Ext:      "flac",
		Filename: "歌名 - 歌手.flac",
	}
	saved, err := saveDownloadedSongToFile(result, dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Skipped {
		t.Fatalf("Skipped = true, want false(更高音质应写入)")
	}
	wantPath := filepath.Join(dir, "歌名 - 歌手.flac")
	if saved.SavedPath != wantPath {
		t.Fatalf("SavedPath = %q, want %q", saved.SavedPath, wantPath)
	}
	if _, err := os.Stat(mp3Path); !os.IsNotExist(err) {
		t.Fatalf("旧 mp3 应被删除")
	}
	if len(saved.RemovedPaths) != 1 || saved.RemovedPaths[0] != mp3Path {
		t.Fatalf("RemovedPaths = %v, want [%q]", saved.RemovedPaths, mp3Path)
	}
}

// result.Ext 为空时,音质档应回退到落盘文件名的扩展名,
// 避免把无损(flac)误判成 mp3 档而被已存在的 mp3 挡下跳过。
func TestSaveDownloadedSongEmptyExtFallsBackToFilename(t *testing.T) {
	dir := t.TempDir()
	mp3Path := filepath.Join(dir, "歌名 - 歌手.mp3")
	if err := os.WriteFile(mp3Path, []byte("mp3-data"), 0644); err != nil {
		t.Fatal(err)
	}

	// Ext 故意留空,但 Filename 是 flac —— 应按 flac 处理:写入并删旧 mp3。
	result := &DownloadedSong{
		Data:     []byte("flac-data"),
		Ext:      "",
		Filename: "歌名 - 歌手.flac",
	}
	saved, err := saveDownloadedSongToFile(result, dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Skipped {
		t.Fatalf("Skipped = true, want false(Ext空应回退到flac档,不该被mp3挡下)")
	}
	if _, err := os.Stat(mp3Path); !os.IsNotExist(err) {
		t.Fatalf("旧 mp3 应被删除")
	}
	if _, err := os.Stat(filepath.Join(dir, "歌名 - 歌手.flac")); err != nil {
		t.Fatalf("flac 应被写入: %v", err)
	}
}
