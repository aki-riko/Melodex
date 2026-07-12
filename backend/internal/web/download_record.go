package web

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"gorm.io/gorm"
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

// downloadStatusItem 是给前端恢复“已下载到服务器”状态的最小视图。
// 不暴露 user_id:普通用户只能查询自己的记录,管理员虽可见全部服务器曲库,
// 也不需要知道每条记录具体属于哪个用户。
type downloadStatusItem struct {
	Source       string    `json:"source"`
	SongID       string    `json:"song_id"`
	Name         string    `json:"name"`
	Artist       string    `json:"artist"`
	RelPath      string    `json:"rel_path"`
	DownloadedAt time.Time `json:"downloaded_at"`
}

// recordDownload 登记一条下载归属(幂等:同用户同文件不重复)。
// relPath 为空则跳过(无法关联磁盘文件的下载不登记)。
func recordDownload(userID uint, relPath, source, songID, name, artist string) error {
	relPath = normalizeRelPath(relPath)
	if userID == 0 || relPath == "" {
		return nil
	}
	rec := DownloadRecord{
		UserID:    userID,
		RelPath:   relPath,
		Source:    strings.TrimSpace(source),
		SongID:    strings.TrimSpace(songID),
		Name:      strings.TrimSpace(name),
		Artist:    strings.TrimSpace(artist),
		CreatedAt: time.Now(),
	}
	return db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}, {Name: "rel_path"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"source", "song_id", "name", "artist", "created_at",
		}),
	}).Create(&rec).Error
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

// existingDownloadStatusForUser 返回当前用户可见、且磁盘文件仍实际存在的下载记录。
// 管理员与本地曲库语义一致:可见全部记录;普通用户只见自己的记录。
//
// DownloadRecord 可能因人工移动/删除文件留下孤儿记录。状态恢复必须与本地音乐
// 实时文件状态相交,不能复用本地曲库 stale-while-revalidate 快照,否则刚下载后
// 立刻刷新仍可能漏掉新文件。
func existingDownloadStatusForUser(userID uint, admin bool, downloadDir string) ([]downloadStatusItem, error) {
	if !admin && userID == 0 {
		return []downloadStatusItem{}, nil
	}

	var records []DownloadRecord
	query := db.Order("created_at DESC, id DESC")
	if !admin {
		query = query.Where("user_id = ?", userID)
	}
	if err := query.Find(&records).Error; err != nil {
		return nil, err
	}

	items := make([]downloadStatusItem, 0, len(records))
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		rel := normalizeRelPath(record.RelPath)
		if !downloadRecordFileExists(downloadDir, rel) {
			continue
		}

		// 同一歌曲可能因历史音质升级留下多条记录。前端只需要一个状态项,
		// 优先按 source+song_id 去重;旧数据缺身份时退回 rel_path。
		recordSource := strings.TrimSpace(record.Source)
		recordSongID := strings.TrimSpace(record.SongID)
		statusKey := rel
		if recordSource != "" && recordSongID != "" {
			statusKey = recordSource + "\x00" + recordSongID
		}
		if _, ok := seen[statusKey]; ok {
			continue
		}
		seen[statusKey] = struct{}{}

		items = append(items, downloadStatusItem{
			Source:       recordSource,
			SongID:       recordSongID,
			Name:         strings.TrimSpace(record.Name),
			Artist:       strings.TrimSpace(record.Artist),
			RelPath:      rel,
			DownloadedAt: record.CreatedAt,
		})
	}
	return items, nil
}

// existingDownloadRelPathForPlayback 为 Web 播放器解析当前用户可见的服务器副本。
// 匹配语义必须与前端“服务器”标记一致:
//   - 先按 source + song_id 精确身份匹配;
//   - 精确身份未命中时,再按完整歌名 + 完整歌手规范化等值匹配。
//
// 每个候选都会实时校验磁盘文件,拒绝孤儿记录、越界路径、目录与符号链接逃逸。
// 普通用户只查询自己的记录;管理员沿用本地曲库规则,可使用任意用户的服务器副本。
func existingDownloadRelPathForPlayback(userID uint, admin bool, downloadDir, source, songID, name, artist string) (string, error) {
	if !admin && userID == 0 {
		return "", nil
	}

	visibleRecords := func() *gorm.DB {
		query := db.Order("created_at DESC, id DESC")
		if !admin {
			query = query.Where("user_id = ?", userID)
		}
		return query
	}

	source = strings.TrimSpace(source)
	songID = strings.TrimSpace(songID)
	if source != "" && songID != "" {
		var exact []DownloadRecord
		if err := visibleRecords().Where("source = ? AND song_id = ?", source, songID).Find(&exact).Error; err != nil {
			return "", err
		}
		if rel := firstExistingDownloadRelPath(exact, downloadDir); rel != "" {
			return rel, nil
		}
	}

	nameKey := normalizeDownloadMatchText(name)
	artistKey := normalizeDownloadMatchText(artist)
	if nameKey == "" || artistKey == "" {
		return "", nil
	}

	var candidates []DownloadRecord
	if err := visibleRecords().Where("name <> '' AND artist <> ''").Find(&candidates).Error; err != nil {
		return "", err
	}
	for _, record := range candidates {
		if normalizeDownloadMatchText(record.Name) != nameKey || normalizeDownloadMatchText(record.Artist) != artistKey {
			continue
		}
		rel := normalizeRelPath(record.RelPath)
		if downloadRecordFileExists(downloadDir, rel) {
			return rel, nil
		}
	}
	return "", nil
}

func firstExistingDownloadRelPath(records []DownloadRecord, downloadDir string) string {
	for _, record := range records {
		rel := normalizeRelPath(record.RelPath)
		if downloadRecordFileExists(downloadDir, rel) {
			return rel
		}
	}
	return ""
}

func normalizeDownloadMatchText(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

// moveDownloadRecordsToPath 在音质升级替换文件扩展名时迁移所有用户的归属。
// 共享旧文件的其他用户也必须继续指向新文件,不能只保留本次下载者。
func moveDownloadRecordsToPath(oldRelPath, newRelPath string) error {
	oldRelPath = normalizeRelPath(oldRelPath)
	newRelPath = normalizeRelPath(newRelPath)
	if oldRelPath == "" || newRelPath == "" || oldRelPath == newRelPath {
		return nil
	}

	return db.Transaction(func(tx *gorm.DB) error {
		var records []DownloadRecord
		if err := tx.Where("rel_path = ?", oldRelPath).Find(&records).Error; err != nil {
			return err
		}
		for _, record := range records {
			oldID := record.ID
			record.ID = 0
			record.RelPath = newRelPath
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "user_id"}, {Name: "rel_path"}},
				DoNothing: true,
			}).Create(&record).Error; err != nil {
				return err
			}
			if err := tx.Delete(&DownloadRecord{}, oldID).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// downloadRecordFileExists 对单条记录做实时、只读、安全的文件检查。
// 使用 Lstat 拒绝目录和符号链接,并验证目标仍位于 DownloadDir 内。
func downloadRecordFileExists(downloadDir, relPath string) bool {
	relPath = normalizeRelPath(relPath)
	if relPath == "" {
		return false
	}

	rootAbs, err := filepath.Abs(strings.TrimSpace(downloadDir))
	if err != nil {
		return false
	}
	targetAbs, err := filepath.Abs(filepath.Join(rootAbs, filepath.FromSlash(relPath)))
	if err != nil || !isPathInside(rootAbs, targetAbs) || !isLocalMusicAudioFile(targetAbs) {
		return false
	}
	// 词法路径位于 DownloadDir 内还不够:祖先目录可能是指向目录外的符号链接。
	// 解析真实路径后再次做 containment 校验;最终节点符号链接由下面的 Lstat 拒绝。
	resolvedRoot, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return false
	}
	resolvedTarget, err := filepath.EvalSymlinks(targetAbs)
	if err != nil || !isPathInside(resolvedRoot, resolvedTarget) {
		return false
	}
	info, err := os.Lstat(targetAbs)
	return err == nil && info.Mode().IsRegular()
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
