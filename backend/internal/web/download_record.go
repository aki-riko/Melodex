package web

import (
	"path/filepath"
	"strings"
	"time"

	"gorm.io/gorm/clause"
)

// DownloadRecord 记录「某用户下载了某个文件」。下载共享同一磁盘目录
// (DownloadDir 全局),靠这张归属表实现本地库的按用户隔离:
// 同一首歌多人下载只占一份磁盘空间,但每人只在自己的本地库看到自己下过的。
// 管理员可见全部。RelPath 是相对 DownloadDir 的路径,作为与磁盘扫描结果的关联键。
type DownloadRecord struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"uniqueIndex:idx_dl_user_path;not null" json:"user_id"`
	RelPath   string    `gorm:"uniqueIndex:idx_dl_user_path;not null" json:"rel_path"`
	Source    string    `json:"source"`
	SongID    string    `json:"song_id"`
	Name      string    `json:"name"`
	Artist    string    `json:"artist"`
	CreatedAt time.Time `json:"created_at"`
}

// recordDownload 登记一条下载归属(幂等:同用户同文件不重复)。
// relPath 为空则跳过(无法关联磁盘文件的下载不登记)。
func recordDownload(userID uint, relPath, source, songID, name, artist string) error {
	relPath = normalizeRelPath(relPath)
	if userID == 0 || relPath == "" {
		return nil
	}
	rec := DownloadRecord{
		UserID:  userID,
		RelPath: relPath,
		Source:  strings.TrimSpace(source),
		SongID:  strings.TrimSpace(songID),
		Name:    strings.TrimSpace(name),
		Artist:  strings.TrimSpace(artist),
	}
	return db.Clauses(clause.OnConflict{DoNothing: true}).Create(&rec).Error
}

// downloadedRelPathsForUser 返回某用户下载过的全部相对路径集合(本地库过滤用)。
func downloadedRelPathsForUser(userID uint) (map[string]struct{}, error) {
	var records []DownloadRecord
	if err := db.Where("user_id = ?", userID).Find(&records).Error; err != nil {
		return nil, err
	}
	set := make(map[string]struct{}, len(records))
	for _, r := range records {
		set[normalizeRelPath(r.RelPath)] = struct{}{}
	}
	return set, nil
}

// deleteDownloadRecordsByPath 删除某文件的所有归属记录(文件被物理删除时调用)。
func deleteDownloadRecordsByPath(relPath string) error {
	relPath = normalizeRelPath(relPath)
	if relPath == "" {
		return nil
	}
	return db.Where("rel_path = ?", relPath).Delete(&DownloadRecord{}).Error
}

// deleteDownloadRecordForUser 删除某用户对某文件的归属(普通用户从自己库移除,
// 不影响他人也不删磁盘文件)。返回该文件是否还被其他用户引用。
func deleteDownloadRecordForUser(userID uint, relPath string) (stillReferenced bool, err error) {
	relPath = normalizeRelPath(relPath)
	if userID == 0 || relPath == "" {
		return false, nil
	}
	if err := db.Where("user_id = ? AND rel_path = ?", userID, relPath).Delete(&DownloadRecord{}).Error; err != nil {
		return false, err
	}
	var remaining int64
	if err := db.Model(&DownloadRecord{}).Where("rel_path = ?", relPath).Count(&remaining).Error; err != nil {
		return false, err
	}
	return remaining > 0, nil
}

// filterLocalTracksForUser 按归属过滤本地扫描结果。
//   - admin=true:返回全部(管理员可见全部本地库)。
//   - 否则:只返回该用户 DownloadRecord 里登记过的文件(按 RelPath 匹配)。
//
// userID=0(异常)按"无任何归属"处理,返回空,避免越权看到全部。
func filterLocalTracksForUser(tracks []*localMusicTrack, userID uint, admin bool) []*localMusicTrack {
	if admin {
		return tracks
	}
	if userID == 0 || len(tracks) == 0 {
		return []*localMusicTrack{}
	}
	owned, err := downloadedRelPathsForUser(userID)
	if err != nil || len(owned) == 0 {
		return []*localMusicTrack{}
	}
	out := make([]*localMusicTrack, 0, len(tracks))
	for _, t := range tracks {
		if t == nil {
			continue
		}
		if _, ok := owned[normalizeRelPath(t.RelPath)]; ok {
			out = append(out, t)
		}
	}
	return out
}

func normalizeRelPath(p string) string {
	p = strings.TrimSpace(p)
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "./")
	p = strings.TrimPrefix(p, "/")
	return p
}

// relPathUnderDir 计算 fullPath 相对 baseDir 的路径(归一化为正斜杠)。
// 若 fullPath 不在 baseDir 下或计算失败,返回 fullPath 的 basename 兜底
// (仍能作为归属键,只是不含子目录层级)。
func relPathUnderDir(baseDir, fullPath string) string {
	baseDir = strings.TrimSpace(baseDir)
	fullPath = strings.TrimSpace(fullPath)
	if fullPath == "" {
		return ""
	}
	if baseDir != "" {
		if rel, err := filepath.Rel(baseDir, fullPath); err == nil {
			rel = normalizeRelPath(rel)
			if rel != "" && !strings.HasPrefix(rel, "../") && rel != ".." {
				return rel
			}
		}
	}
	return normalizeRelPath(filepath.Base(fullPath))
}
