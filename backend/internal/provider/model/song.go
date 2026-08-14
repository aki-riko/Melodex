package model

import (
	"errors"
	"fmt"
)

var ErrPlaylistCategoriesUnsupported = errors.New("playlist categories not supported")
var ErrUserPlaylistsUnsupported = errors.New("user playlists not supported")

// Song is the stable Melodex representation shared by provider adapters.
type Song struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Artist    string            `json:"artist"`
	Album     string            `json:"album"`
	AlbumID   string            `json:"album_id"`
	Duration  int               `json:"duration"`
	Size      int64             `json:"size"`
	Bitrate   int               `json:"bitrate"`
	Source    string            `json:"source"`
	URL       string            `json:"url"`
	Ext       string            `json:"ext"`
	Cover     string            `json:"cover"`
	Link      string            `json:"link"`
	Extra     map[string]string `json:"extra,omitempty"`
	IsInvalid bool              `json:"is_invalid,omitempty"`
	IsVIP     bool              `json:"is_vip,omitempty"`
}

type Playlist struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Cover       string            `json:"cover"`
	TrackCount  int               `json:"track_count"`
	PlayCount   int               `json:"play_count"`
	Creator     string            `json:"creator"`
	Description string            `json:"description"`
	Source      string            `json:"source"`
	Link        string            `json:"link"`
	Extra       map[string]string `json:"extra,omitempty"`
}

type PlaylistCategory struct {
	ID     string            `json:"id"`
	Name   string            `json:"name"`
	Group  string            `json:"group"`
	Source string            `json:"source"`
	Count  int               `json:"count"`
	Hot    bool              `json:"hot,omitempty"`
	Extra  map[string]string `json:"extra,omitempty"`
}

func (s *Song) FormatDuration() string {
	if s.Duration == 0 {
		return "-"
	}
	return fmt.Sprintf("%02d:%02d", s.Duration/60, s.Duration%60)
}

func (s *Song) FormatSize() string {
	if s.Size == 0 {
		return "-"
	}
	return fmt.Sprintf("%.2f MB", float64(s.Size)/1024/1024)
}

func (s *Song) FormatBitrate() string {
	if s.Bitrate == 0 {
		return "-"
	}
	return fmt.Sprintf("%d kbps", s.Bitrate)
}

func (s *Song) Display() string {
	return s.Name + " - " + s.Artist
}
