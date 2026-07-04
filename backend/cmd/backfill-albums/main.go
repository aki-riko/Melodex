package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
	"gorm.io/gorm"
)

type songRow struct {
	TableName string
	ID        uint
	Source    string
	SongID    string
	Name      string
	Artist    string
	Extra     string
}

type albumMeta struct {
	Album   string
	AlbumID string
}

func main() {
	dryRun := flag.Bool("dry-run", true, "show what would be updated without writing")
	limit := flag.Int("limit", 0, "max rows to inspect")
	delay := flag.Duration("delay", 200*time.Millisecond, "delay between upstream searches")
	flag.Parse()

	core.CM.Load()
	db, err := core.OpenAppDatabase()
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	sqlDB, err := db.DB()
	if err == nil {
		defer sqlDB.Close()
	}

	rows, err := loadMissingRows(db, *limit)
	if err != nil {
		log.Fatalf("load missing rows: %v", err)
	}
	log.Printf("missing album rows: %d dry_run=%v", len(rows), *dryRun)

	cache := map[string][]model.Song{}
	updated := 0
	unmatched := 0
	for i, row := range rows {
		extra := decodeExtra(row.Extra)
		targetIDs := rowIDs(row, extra)
		match, ok := resolveAlbum(row, targetIDs, cache)
		if !ok || strings.TrimSpace(match.Album) == "" {
			unmatched++
			fmt.Printf("MISS %s#%d %s %s - %s\n", row.TableName, row.ID, row.Source, row.Name, row.Artist)
		} else {
			extra["album"] = match.Album
			if match.AlbumID != "" && strings.TrimSpace(extra["album_id"]) == "" {
				extra["album_id"] = match.AlbumID
			}
			raw, _ := json.Marshal(extra)
			if *dryRun {
				fmt.Printf("DRY  %s#%d %s %s - %s => %s\n", row.TableName, row.ID, row.Source, row.Name, row.Artist, match.Album)
			} else {
				if err := db.Table(row.TableName).Where("id = ?", row.ID).Update("extra", string(raw)).Error; err != nil {
					log.Printf("update %s#%d failed: %v", row.TableName, row.ID, err)
					unmatched++
					continue
				}
				fmt.Printf("OK   %s#%d %s %s - %s => %s\n", row.TableName, row.ID, row.Source, row.Name, row.Artist, match.Album)
			}
			updated++
		}

		if *delay > 0 && i < len(rows)-1 {
			time.Sleep(*delay)
		}
	}

	log.Printf("done inspected=%d matched=%d unmatched=%d dry_run=%v", len(rows), updated, unmatched, *dryRun)
}

func loadMissingRows(db *gorm.DB, limit int) ([]songRow, error) {
	sql := `
WITH missing AS (
  SELECT 'saved_songs' AS table_name, id, source, song_id, name, artist, extra
  FROM saved_songs
  WHERE COALESCE((CASE WHEN COALESCE(TRIM(extra), '') IN ('', 'null') THEN '{}'::jsonb ELSE extra::jsonb END)->>'album', '') = ''
  UNION ALL
  SELECT 'play_history_rows' AS table_name, id, source, song_id, name, artist, extra
  FROM play_history_rows
  WHERE COALESCE((CASE WHEN COALESCE(TRIM(extra), '') IN ('', 'null') THEN '{}'::jsonb ELSE extra::jsonb END)->>'album', '') = ''
)
SELECT table_name, id, source, song_id, name, artist, extra
FROM missing
WHERE source IN ('qq', 'netease', 'kugou', 'kuwo', 'migu', 'qianqian', 'soda', 'joox', 'jamendo', 'apple')
ORDER BY table_name, id`
	args := []interface{}{}
	if limit > 0 {
		sql += "\nLIMIT ?"
		args = append(args, limit)
	}
	var rows []songRow
	if err := db.Raw(sql, args...).Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func decodeExtra(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" || raw == "{}" {
		return map[string]string{}
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return map[string]string{}
	}
	extra := make(map[string]string, len(decoded))
	for key, value := range decoded {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprint(value))
		if text != "" {
			extra[key] = text
		}
	}
	return extra
}

func rowIDs(row songRow, extra map[string]string) map[string]struct{} {
	ids := map[string]struct{}{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value != "" {
			ids[value] = struct{}{}
		}
	}
	add(row.SongID)
	add(extra["song_id"])
	add(extra["songmid"])
	add(extra["content_id"])
	if extra["content_id"] != "" && extra["resource_type"] != "" && extra["format_type"] != "" {
		add(extra["content_id"] + "|" + extra["resource_type"] + "|" + extra["format_type"])
	}
	return ids
}

func resolveAlbum(row songRow, targetIDs map[string]struct{}, cache map[string][]model.Song) (albumMeta, bool) {
	search := core.GetSearchFunc(row.Source)
	if search == nil {
		return albumMeta{}, false
	}
	queries := []string{
		strings.TrimSpace(row.Name + " " + row.Artist),
		strings.TrimSpace(row.Name),
	}
	for _, query := range queries {
		if query == "" {
			continue
		}
		key := row.Source + "\x00" + query
		songs, ok := cache[key]
		if !ok {
			var err error
			songs, err = search(query)
			if err != nil {
				log.Printf("search %s %q failed: %v", row.Source, query, err)
				cache[key] = nil
				continue
			}
			cache[key] = songs
		}
		if meta, ok := findMatch(songs, targetIDs); ok {
			return meta, true
		}
	}
	if meta, ok := resolveAlbumByParse(row, targetIDs); ok {
		return meta, true
	}
	return albumMeta{}, false
}

func findMatch(songs []model.Song, targetIDs map[string]struct{}) (albumMeta, bool) {
	for _, song := range songs {
		for _, id := range candidateIDs(song) {
			if _, ok := targetIDs[id]; !ok {
				continue
			}
			return albumFromSong(song)
		}
	}
	return albumMeta{}, false
}

func resolveAlbumByParse(row songRow, targetIDs map[string]struct{}) (albumMeta, bool) {
	parse := core.GetParseFunc(row.Source)
	if parse == nil {
		return albumMeta{}, false
	}
	for _, link := range parseLinks(row.Source, targetIDs) {
		song, err := parse(link)
		if err != nil || song == nil {
			continue
		}
		if !hasAnyID(candidateIDs(*song), targetIDs) {
			continue
		}
		if meta, ok := albumFromSong(*song); ok {
			return meta, true
		}
	}
	return albumMeta{}, false
}

func parseLinks(source string, targetIDs map[string]struct{}) []string {
	links := []string{}
	seen := map[string]struct{}{}
	add := func(link string) {
		link = strings.TrimSpace(link)
		if link == "" {
			return
		}
		if _, ok := seen[link]; ok {
			return
		}
		seen[link] = struct{}{}
		links = append(links, link)
	}
	for id := range targetIDs {
		switch source {
		case "qq":
			add("https://y.qq.com/n/ryqq/songDetail/" + id)
			if isDigitsOnly(id) {
				add("https://y.qq.com/n/ryqq/player?songid=" + id)
			}
		case "netease":
			if isDigitsOnly(id) {
				add("https://music.163.com/#/song?id=" + id)
			}
		}
	}
	return links
}

func albumFromSong(song model.Song) (albumMeta, bool) {
	album := strings.TrimSpace(song.Album)
	if album == "" {
		album = firstExtra(song.Extra, "album", "albumName", "albumname", "album_name")
	}
	if album == "" {
		return albumMeta{}, false
	}
	albumID := strings.TrimSpace(song.AlbumID)
	if albumID == "" {
		albumID = firstExtra(song.Extra, "album_id", "albumMid", "album_mid", "albummid")
	}
	return albumMeta{Album: album, AlbumID: albumID}, true
}

func candidateIDs(song model.Song) []string {
	ids := []string{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value != "" {
			ids = append(ids, value)
		}
	}
	add(song.ID)
	if song.Extra != nil {
		add(song.Extra["song_id"])
		add(song.Extra["songmid"])
		add(song.Extra["content_id"])
		if song.Extra["content_id"] != "" && song.Extra["resource_type"] != "" && song.Extra["format_type"] != "" {
			add(song.Extra["content_id"] + "|" + song.Extra["resource_type"] + "|" + song.Extra["format_type"])
		}
	}
	return ids
}

func hasAnyID(candidates []string, targetIDs map[string]struct{}) bool {
	for _, id := range candidates {
		if _, ok := targetIDs[id]; ok {
			return true
		}
	}
	return false
}

func isDigitsOnly(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func firstExtra(extra map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(extra[key]); value != "" {
			return value
		}
	}
	return ""
}
