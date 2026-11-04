package core

import "testing"

// 「QQ 凭证能不能自动续期」的契约测试。
//
// 背景:QQ musickey 只有 72h,设置页会给它显示「剩 X 小时」的黄条。用户看到后
// 的第一反应是要重新扫码 —— 但只要 cookie 里还有长期授权 token,sidecar 会在下次
// 搜索时用 refresh_musickey 自动换出新的 key(provider_bridge/qq_source.py),
// 用户什么都不用做。所以真正要回答的问题是:「这份 cookie,sidecar 换得动吗?」
//
// 这个判断原先和 sidecar 的实际行为**对不上**:
//   · Go 侧 hints 只有 has_refresh_key / has_refresh_token;
//   · 但 refresh_musickey 实际拿的是 TOKEN_KEYS(p_skey/skey/superkey/supertoken/
//     pt_oauth_token),refresh_token 只是其中一个可选来源。
// 于是一份「扫码登录、p_skey 齐全、但偏偏没有 refresh_token」的 cookie 会被判成
// 不可续期,把用户赶去白扫一次码 —— 而它其实自己就能续。
//
// 这里用三组分量把它钉死:能续的前提是 sidecar 真的换得动。

// qqRefreshingCookie 模拟一次真实扫码登录得到的 cookie:有会员 key,
// 同时带 p_skey 这类长期授权 token(但**没有** refresh_token —— 这正是旧判据漏掉的情形)。
const qqRefreshingCookie = "uin=0123456789; str_musicid=0123456789" +
	"; musickey=KEY; qm_keyst=KEY; qqmusic_key=KEY; p_skey=LONG_LIVED" +
	"; musickeyCreateTime=1800000000; keyExpiresIn=259200"

func TestAutoRefreshableRequiresLongLivedToken(t *testing.T) {
	const now = int64(1_800_000_000)
	withFixedNow(t, now)

	t.Run("扫码登录(有 p_skey)→ 可自动续期", func(t *testing.T) {
		detail := BuildCookieStatusDetail("qq", qqRefreshingCookie, false)
		if !detail.AutoRefreshable {
			t.Fatalf("带长期授权 token 的 QQ cookie 应可自动续期, hints=%#v", detail.Hints)
		}
		// 只有 p_skey、没有 refresh_token 也必须成立 —— 这正是历史 bug 的现场。
		if detail.Hints["has_refresh_token"] {
			t.Fatal("该用例刻意不含 refresh_token, fixture 被改坏了")
		}
		if !detail.Hints["has_long_lived_token"] {
			t.Fatal("has_long_lived_token 应识别 p_skey")
		}
	})

	t.Run("手填但只有会员 key → 不可自动续期", func(t *testing.T) {
		// 早期手填 Cookie 常常只拷了 qm_keyst 一类的强凭证,没有授权 token。
		// sidecar 的 refresh_musickey 拿不到任何候选 token 会直接返回 {} ——
		// 所以这里必须如实说"续不了",否则用户会在真过期时毫无准备。
		bare := "uin=0123456789; musickey=KEY; qm_keyst=KEY" +
			"; musickeyCreateTime=1800000000; keyExpiresIn=259200"
		detail := BuildCookieStatusDetail("qq", bare, false)
		if detail.AutoRefreshable {
			t.Fatalf("没有长期 token 时不应承诺自动续期, hints=%#v", detail.Hints)
		}
		if detail.Hints["has_long_lived_token"] {
			t.Fatal("bare cookie 不该判定有长期 token")
		}
	})

	t.Run("缺 uin → 不可自动续期", func(t *testing.T) {
		// refresh_musickey 开头就要求 uin,拿不到直接返回 {}。
		noUin := "musickey=KEY; qm_keyst=KEY; p_skey=LONG_LIVED" +
			"; musickeyCreateTime=1800000000; keyExpiresIn=259200"
		detail := BuildCookieStatusDetail("qq", noUin, false)
		if detail.AutoRefreshable {
			t.Fatalf("缺 uin 时 sidecar 换不出新 key,不应承诺自动续期, hints=%#v", detail.Hints)
		}
	})

	t.Run("refresh_token 也算长期凭据", func(t *testing.T) {
		withToken := "uin=0123456789; musickey=KEY; qm_keyst=KEY; refresh_token=RT" +
			"; musickeyCreateTime=1800000000; keyExpiresIn=259200"
		detail := BuildCookieStatusDetail("qq", withToken, false)
		if !detail.AutoRefreshable {
			t.Fatalf("refresh_token 是 sidecar 的候选之一,应算可续期, hints=%#v", detail.Hints)
		}
	})

	t.Run("非 QQ 源一律不可自动续期", func(t *testing.T) {
		// 目前只有 QQ 做了 musickey 续期;别的源不能被误标成"会自动续"。
		if credentialAutoRefreshable("netease", map[string]bool{"has_long_lived_token": true, "has_uin": true, "has_music_key": true}) {
			t.Fatal("网易没有自动续期实现,不应靠 hints 骗出 true")
		}
		if credentialAutoRefreshable("kugou", nil) {
			t.Fatal("未知源不应判定为可自动续期")
		}
	})
}

// 剩余时间与"能否续期"是两件独立的事:快到期不代表不能续。
// 这条防止有人把 AutoRefreshable 错误地绑到 state 上。
func TestAutoRefreshableIndependentOfRemainingTime(t *testing.T) {
	const now = int64(1_800_000_000)
	withFixedNow(t, now)

	// 创建于 now-3h,keyExpiresIn=72h → 还剩 69h,state=ok,但仍可续期。
	detail := BuildCookieStatusDetail("qq", qqRefreshingCookie, false)
	if detail.State != "ok" {
		t.Fatalf("state = %q, 期望 ok(剩余 %d 秒)", detail.State, detail.ExpiresInSeconds)
	}
	if !detail.AutoRefreshable {
		t.Fatal("ok 状态同样应标记可自动续期 —— 它描述的是能力,不是紧迫程度")
	}
}
