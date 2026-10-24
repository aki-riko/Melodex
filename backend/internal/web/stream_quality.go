package web

import (
	"log"
	"path/filepath"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 服务器副本优先是 2026-07 的设计:有本地文件时不再回源,避免在线地址过期、
// 也让 Web 播放与界面「服务器」状态指向同一份真实文件。
//
// 但它当初没有比较音质,于是留下一个死角:某首歌在还没有会员/无损凭证时被
// 自动下载落盘成 128k mp3,之后账号升级、在线源已经能给 FLAC,Web 仍会永远
// 播那份旧的低码率文件 —— 列表标签来自对**在线源**的 inspect(显示"无损"),
// 耳朵听到的却是磁盘上的有损副本。这里的门控就是补上这一次比较。
//
// 判定必须保守:只有拿到"磁盘是有损、在线明确声称无损"这种正面证据才改用在线源;
// 其余情况(含拿不到扩展名、在线没声明无损但码率不明)一律沿用副本,不额外回源。

// lossyStreamExtensions 是明确有损的扩展名集合。无损扩展名走 core 的同一份口径。
var lossyStreamExtensions = map[string]struct{}{
	"mp3": {}, "aac": {}, "m4a": {}, "ogg": {}, "oga": {}, "opus": {}, "wma": {},
}

func streamExtensionFromRelPath(relPath string) string {
	return strings.ToLower(strings.TrimPrefix(filepath.Ext(strings.TrimSpace(relPath)), "."))
}

func isLossyStreamExtension(extension string) bool {
	_, ok := lossyStreamExtensions[strings.ToLower(strings.TrimSpace(extension))]
	return ok
}

// trackClaimsLossless: 在线源是否明确声明这首能拿到无损。
// has_lossless 由 provider sidecar 在解析出真实下载地址后写入(见 app.py 的
// song_to_payload 与 netease_source/qq_source 的实现)。
func trackClaimsLossless(track *model.Track) bool {
	if track == nil {
		return false
	}
	return strings.TrimSpace(track.Extra["has_lossless"]) == "1"
}

// shouldStreamFromServerCopy 决定 stream=1 时是否直接发磁盘副本(而非回源)。
// 返回 false 表示"应该先试在线源",调用方必须准备在线失败后回退到副本。
func shouldStreamFromServerCopy(relPath string, track *model.Track) bool {
	extension := streamExtensionFromRelPath(relPath)
	if !isLossyStreamExtension(extension) {
		// 无损副本(或无法判定的扩展名)保持原有优先语义。
		return true
	}
	if trackClaimsLossless(track) {
		return false
	}
	return true
}

// logStreamCopyBypass 在为了音质而放弃使用副本时留一条可巡检的记录。
func logStreamCopyBypass(track *model.Track, relPath string) {
	if track == nil {
		return
	}
	log.Printf("[stream] 副本为有损(%s),在线源声明无损,改走在线 source=%q id=%q rel=%q",
		streamExtensionFromRelPath(relPath), track.Source, track.ID, relPath)
}
