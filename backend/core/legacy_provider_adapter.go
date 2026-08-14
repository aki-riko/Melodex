package core

import (
	providermodel "github.com/guohuiyuan/go-music-dl/internal/provider/model"
	legacymodel "github.com/guohuiyuan/music-lib/model"
)

func adaptLegacySongSearch(search func(string) ([]legacymodel.Song, error)) SearchFunc {
	return func(keyword string) ([]providermodel.Song, error) {
		songs, err := search(keyword)
		return providerSongsFromLegacy(songs), err
	}
}

func adaptLegacyPlaylistSearch(search func(string) ([]legacymodel.Playlist, error)) SearchPlaylistFunc {
	return func(keyword string) ([]providermodel.Playlist, error) {
		playlists, err := search(keyword)
		return providerPlaylistsFromLegacy(playlists), err
	}
}

func adaptLegacySongDetail(load func(string) ([]legacymodel.Song, error)) func(string) ([]providermodel.Song, error) {
	return func(id string) ([]providermodel.Song, error) {
		songs, err := load(id)
		return providerSongsFromLegacy(songs), err
	}
}

func adaptLegacyPlaylistList(load func() ([]legacymodel.Playlist, error)) func() ([]providermodel.Playlist, error) {
	return func() ([]providermodel.Playlist, error) {
		playlists, err := load()
		return providerPlaylistsFromLegacy(playlists), err
	}
}

func adaptLegacyCategories(load func() ([]legacymodel.PlaylistCategory, error)) PlaylistCategoriesFunc {
	return func() ([]providermodel.PlaylistCategory, error) {
		categories, err := load()
		result := make([]providermodel.PlaylistCategory, 0, len(categories))
		for _, category := range categories {
			result = append(result, providermodel.PlaylistCategory{
				ID: category.ID, Name: category.Name, Group: category.Group,
				Source: category.Source, Count: category.Count, Hot: category.Hot,
				Extra: cloneStringMap(category.Extra),
			})
		}
		return result, err
	}
}

func adaptLegacyCategoryPlaylists(load func(string, int, int) ([]legacymodel.Playlist, error)) CategoryPlaylistsFunc {
	return func(categoryID string, page, limit int) ([]providermodel.Playlist, error) {
		playlists, err := load(categoryID, page, limit)
		return providerPlaylistsFromLegacy(playlists), err
	}
}

func adaptLegacyQRCreate(create func() (*legacymodel.QRLoginSession, error)) QRLoginCreateFunc {
	return func() (*providermodel.QRLoginSession, error) {
		session, err := create()
		if session == nil {
			return nil, err
		}
		return &providermodel.QRLoginSession{
			Source: session.Source, Key: session.Key, URL: session.URL,
			ImageURL: session.ImageURL, State: session.State, ExpiresAt: session.ExpiresAt,
			Extra: cloneStringMap(session.Extra),
		}, err
	}
}

func adaptLegacyQRCheck(check func(string) (*legacymodel.QRLoginResult, error)) QRLoginCheckFunc {
	return func(key string) (*providermodel.QRLoginResult, error) {
		result, err := check(key)
		if result == nil {
			return nil, err
		}
		cookies := cloneStringMap(result.Cookies)
		return &providermodel.QRLoginResult{
			Source: result.Source, Key: result.Key,
			Status: providermodel.QRLoginStatus(result.Status), Message: result.Message,
			Cookie: result.Cookie, Cookies: cookies, Extra: cloneStringMap(result.Extra),
		}, err
	}
}

func adaptLegacyUserPlaylists(load func(int, int) ([]legacymodel.Playlist, error)) UserPlaylistsFunc {
	return func(page, limit int) ([]providermodel.Playlist, error) {
		playlists, err := load(page, limit)
		return providerPlaylistsFromLegacy(playlists), err
	}
}

func adaptLegacySongParse(parse func(string) (*legacymodel.Song, error)) func(string) (*providermodel.Song, error) {
	return func(link string) (*providermodel.Song, error) {
		song, err := parse(link)
		if song == nil {
			return nil, err
		}
		converted := providerSongFromLegacy(*song)
		return &converted, err
	}
}

func adaptLegacyCollectionParse(parse func(string) (*legacymodel.Playlist, []legacymodel.Song, error)) func(string) (*providermodel.Playlist, []providermodel.Song, error) {
	return func(link string) (*providermodel.Playlist, []providermodel.Song, error) {
		playlist, songs, err := parse(link)
		var converted *providermodel.Playlist
		if playlist != nil {
			value := providerPlaylistFromLegacy(*playlist)
			converted = &value
		}
		return converted, providerSongsFromLegacy(songs), err
	}
}

func providerSongsFromLegacy(songs []legacymodel.Song) []providermodel.Song {
	if songs == nil {
		return nil
	}
	result := make([]providermodel.Song, 0, len(songs))
	for _, song := range songs {
		result = append(result, providerSongFromLegacy(song))
	}
	return result
}

func providerSongFromLegacy(song legacymodel.Song) providermodel.Song {
	return providermodel.Song{
		ID: song.ID, Name: song.Name, Artist: song.Artist, Album: song.Album,
		AlbumID: song.AlbumID, Duration: song.Duration, Size: song.Size,
		Bitrate: song.Bitrate, Source: song.Source, URL: song.URL, Ext: song.Ext,
		Cover: song.Cover, Link: song.Link, Extra: cloneStringMap(song.Extra),
		IsInvalid: song.IsInvalid, IsVIP: song.IsVIP,
	}
}

func providerPlaylistsFromLegacy(playlists []legacymodel.Playlist) []providermodel.Playlist {
	if playlists == nil {
		return nil
	}
	result := make([]providermodel.Playlist, 0, len(playlists))
	for _, playlist := range playlists {
		result = append(result, providerPlaylistFromLegacy(playlist))
	}
	return result
}

func providerPlaylistFromLegacy(playlist legacymodel.Playlist) providermodel.Playlist {
	return providermodel.Playlist{
		ID: playlist.ID, Name: playlist.Name, Cover: playlist.Cover,
		TrackCount: playlist.TrackCount, PlayCount: playlist.PlayCount,
		Creator: playlist.Creator, Description: playlist.Description,
		Source: playlist.Source, Link: playlist.Link, Extra: cloneStringMap(playlist.Extra),
	}
}
