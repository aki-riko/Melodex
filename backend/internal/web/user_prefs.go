package web

import (
	"encoding/json"
	"time"

	"github.com/guohuiyuan/go-music-dl/core"
	"gorm.io/gorm/clause"
)

// userPrefRow 是用户偏好的存储行(每用户一行,偏好以 JSON 存 value)。
type userPrefRow struct {
	UserID    uint      `gorm:"primaryKey" json:"user_id"`
	Value     string    `gorm:"type:text;not null" json:"-"`
	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"-"`
}

// UserPref 是按用户隔离的展示类偏好(不影响落盘文件,故与共享下载目录去重不冲突)。
// 目前仅:浮动歌词开关、每页条数。其余设置(下载目录/并发/文件名模板/更新/代理)
// 为系统级全局设置,仅管理员可改。
type UserPref struct {
	DisableFloatingLyrics bool `json:"disableFloatingLyrics"`
	WebPageSize           int  `json:"webPageSize"`
}

// getUserPref 读取用户偏好(无记录返回基于全局默认的偏好)。
func getUserPref(userID uint) UserPref {
	base := core.GetWebSettings()
	pref := UserPref{
		DisableFloatingLyrics: base.DisableFloatingLyrics,
		WebPageSize:           base.WebPageSize,
	}
	if userID == 0 || db == nil {
		return pref
	}
	var row userPrefRow
	if err := db.Where("user_id = ?", userID).Limit(1).Find(&row).Error; err != nil {
		return pref
	}
	if row.UserID == 0 {
		return pref // 无记录,用全局默认
	}
	var stored UserPref
	if err := json.Unmarshal([]byte(row.Value), &stored); err != nil {
		return pref
	}
	pref.DisableFloatingLyrics = stored.DisableFloatingLyrics
	if stored.WebPageSize > 0 {
		pref.WebPageSize = stored.WebPageSize
	}
	return pref
}

// saveUserPref 持久化用户偏好。
func saveUserPref(userID uint, pref UserPref) error {
	if userID == 0 || db == nil {
		return nil
	}
	if pref.WebPageSize <= 0 {
		pref.WebPageSize = core.DefaultWebPageSize
	}
	if pref.WebPageSize > 200 {
		pref.WebPageSize = 200
	}
	data, err := json.Marshal(pref)
	if err != nil {
		return err
	}
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&userPrefRow{UserID: userID, Value: string(data)}).Error
}

// effectiveSettingsForUser 返回合并后的设置视图:系统级全局设置 + 当前用户的展示偏好。
// 前端拿到一份完整 WebSettings(无感),但写入时分流(系统设置管理员改,偏好用户改)。
func effectiveSettingsForUser(userID uint) core.WebSettings {
	settings := core.GetWebSettings()
	if userID == 0 {
		return settings
	}
	pref := getUserPref(userID)
	settings.DisableFloatingLyrics = pref.DisableFloatingLyrics
	settings.WebPageSize = pref.WebPageSize
	return settings
}
