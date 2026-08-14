package model

// Track is the provider-neutral audio item consumed by Melodex services.
// JSON names are the public API contract and intentionally remain stable.
type Track struct {
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

// RemoteCollection represents an album or playlist owned by a provider.
type RemoteCollection struct {
	Extra       map[string]string `json:"extra,omitempty"`
	TrackCount  int               `json:"track_count"`
	PlayCount   int               `json:"play_count"`
	ID          string            `json:"id"`
	Source      string            `json:"source"`
	Name        string            `json:"name"`
	Creator     string            `json:"creator"`
	Description string            `json:"description"`
	Cover       string            `json:"cover"`
	Link        string            `json:"link"`
}

// RemoteCategory groups provider collections for browse endpoints.
type RemoteCategory struct {
	Extra  map[string]string `json:"extra,omitempty"`
	Count  int               `json:"count"`
	Hot    bool              `json:"hot,omitempty"`
	ID     string            `json:"id"`
	Source string            `json:"source"`
	Name   string            `json:"name"`
	Group  string            `json:"group"`
}
