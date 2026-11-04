package model

// ChorusPoint 是一首歌的副歌起止点位(毫秒)。
//
// 为什么单独立一个模型而不是塞进 Track.Extra: 副歌是**按歌曲身份(source+song_id)**
// 获取的独立数据, 本地库补副歌时手上根本没有完整的 Track, 只有 (source, song_id)。
// 用一个窄类型做 Provider 与 Web 层之间的契约, 比让它俩各自解析 map 更不容易写错。
type ChorusPoint struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Valid 判断点位是否可自证合理: 起点为正、终点晚于起点。
//
// 前端要在播放进度条上画区间, 脏数据画出来的标记比不画更误导人,
// 所以校验放在数据进入系统的最外层(Provider 响应解析处), 而不是让每个调用方各判一次。
func (p ChorusPoint) Valid() bool {
	return p.Start > 0 && p.End > p.Start
}
