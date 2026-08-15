package model

// Track is the provider-neutral audio item consumed by Melodex services.
// JSON names are the public API contract and intentionally remain stable.
type Track struct {
	Extra     map[string]string `json:"extra,omitempty"`
	Size      int64             `json:"size"`
	Duration  int               `json:"duration"`
	Bitrate   int               `json:"bitrate"`
	ID        string            `json:"id"`
	Source    string            `json:"source"`
	Name      string            `json:"name"`
	Artist    string            `json:"artist"`
	Album     string            `json:"album"`
	AlbumID   string            `json:"album_id"`
	URL       string            `json:"url"`
	Cover     string            `json:"cover"`
	Link      string            `json:"link"`
	Ext       string            `json:"ext"`
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
