package core

import (
	"encoding/json"
	"strings"
	"testing"
)

// 凭证有效期推算的契约测试。
//
// 需求背景(用户反馈):「凭证过期之后能不能显示一下」——
// 现状是凭证失效后没有任何提示,只是音质悄悄从无损退回 128k,
// 用户不知道为什么,只能自己猜到去重新登录。
//
// 可用的过期证据有两种,可信度和适用范围都不同:
//   1. QQ: cookie 自带 psrf_musickey_createtime + keyexpiresin → 完全离线可算
//   2. 网易: 没有时间字段,只能在线探测(/api/nuser/account/get)
// 其余源两者都没有 → unknown(绝不能瞎猜成"过期")
//
// 这些分支很容易写错且错了很难发现(界面上只是个徽章),所以逐条锁死。

// withFixedNow 在测试期间固定"当前时间",避免依赖真实时钟。
func withFixedNow(t *testing.T, unix int64) {
	t.Helper()
	original := nowUnix
	nowUnix = func() int64 { return unix }
	t.Cleanup(func() { nowUnix = original })
}

func qqCookie(createdUnix int64, ttlSeconds int64) string {
	return "uin=0123456789; str_musicid=0123456789; musickey=TOKEN; qm_keyst=TOKEN; qqmusic_key=TOKEN" +
		"; psrf_musickey_createtime=" + itoa(createdUnix) +
		"; keyexpiresin=" + itoa(ttlSeconds)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf []byte
	for v > 0 {
		buf = append([]byte{byte('0' + v%10)}, buf...)
		v /= 10
	}
	if neg {
		return "-" + string(buf)
	}
	return string(buf)
}

const qqTTL = int64(259200) // 实测 QQ musickey 有效期 72h
const day = int64(86400)

// ---- 1. QQ 三种状态:ok / expiring_soon / expired ----

func TestQQCredentialExpiryStates(t *testing.T) {
	const now = int64(1_800_000_000)

	t.Run("剩余时间长 → ok", func(t *testing.T) {
		withFixedNow(t, now)
		detail := BuildCookieStatusDetail("qq", qqCookie(now-3600, qqTTL), false)
		if detail.State != "ok" {
			t.Fatalf("state = %q, want ok (剩余 %d 秒)", detail.State, detail.ExpiresInSeconds)
		}
		if detail.ExpirySource != "musickey" {
			t.Fatalf("expiry source = %q, want musickey", detail.ExpirySource)
		}
		if detail.ExpiresAt != now-3600+qqTTL {
			t.Fatalf("expires_at = %d, want %d", detail.ExpiresAt, now-3600+qqTTL)
		}
	})

	t.Run("剩余不足 24h → expiring_soon", func(t *testing.T) {
		withFixedNow(t, now)
		// 已过去 71h,剩 1h
		created := now - 71*3600
		detail := BuildCookieStatusDetail("qq", qqCookie(created, qqTTL), false)
		if detail.State != "expiring_soon" {
			t.Fatalf("state = %q, want expiring_soon (剩余 %d 秒)", detail.State, detail.ExpiresInSeconds)
		}
		if detail.ExpiresInSeconds <= 0 || detail.ExpiresInSeconds > CookieExpiringSoonSeconds {
			t.Fatalf("剩余秒数 = %d,应落在 (0, %d]", detail.ExpiresInSeconds, CookieExpiringSoonSeconds)
		}
	})

	t.Run("已过期 → expired(剩余为负)", func(t *testing.T) {
		withFixedNow(t, now)
		created := now - qqTTL - 3600 // 超出 1 小时
		detail := BuildCookieStatusDetail("qq", qqCookie(created, qqTTL), false)
		if detail.State != "expired" {
			t.Fatalf("state = %q, want expired (剩余 %d 秒)", detail.State, detail.ExpiresInSeconds)
		}
		if detail.ExpiresInSeconds >= 0 {
			t.Fatalf("过期时 expires_in_seconds 应为负数,got %d", detail.ExpiresInSeconds)
		}
	})
}

// ---- 2. expired_at 必须被忽略(它是另一套 token 的生命周期) ----
//
// 生产实测:同一份 QQ cookie 里 keyexpiresin=259200(3天) 而
// expired_at = 创建时间 + 60 天。若采用 expired_at,会把"3 天后过期"
// 错报成"60 天后过期" —— 用户在最该被提醒时看不到提醒。
func TestQQCredentialIgnoresExpiredAtField(t *testing.T) {
	const now = int64(1_800_000_000)
	withFixedNow(t, now)
	cookie := "uin=1; musickey=T; psrf_musickey_createtime=" + itoa(now-100) +
		"; keyexpiresin=" + itoa(qqTTL) +
		"; expired_at=" + itoa(now+60*day) // 另一个 token 的 60 天生命周期
	detail := BuildCookieStatusDetail("qq", cookie, false)
	want := now - 100 + qqTTL
	if detail.ExpiresAt != want {
		t.Fatalf("expires_at = %d, want %d(必须按 keyexpiresin,忽略 expired_at)", detail.ExpiresAt, want)
	}
	if detail.State != "ok" {
		t.Fatalf("state = %q, want ok", detail.State)
	}
}

// ---- 3. 毫秒时间戳兼容 ----
func TestQQCredentialAcceptsMillisecondTimestamps(t *testing.T) {
	const now = int64(1_800_000_000)
	withFixedNow(t, now)
	createdMs := (now - 3600) * 1000
	detail := BuildCookieStatusDetail("qq", qqCookie(createdMs, qqTTL), false)
	// 毫秒被归一化后应算成"过去 1 小时",不是"1970 年之前"
	if detail.State != "ok" {
		t.Fatalf("state = %q, want ok（毫秒时间戳应被识别）; expires_in=%d", detail.State, detail.ExpiresInSeconds)
	}
}

// ---- 4. 缺少 keyexpiresin 时按官方默认 72h 兜底 ----
func TestQQCredentialFallsBackToDefaultTTL(t *testing.T) {
	const now = int64(1_800_000_000)
	withFixedNow(t, now)
	cookie := "uin=1; musickey=T; psrf_musickey_createtime=" + itoa(now-3600)
	detail := BuildCookieStatusDetail("qq", cookie, false)
	if detail.ExpiresAt != now-3600+qqTTL {
		t.Fatalf("expires_at = %d, want %d(默认 72h)", detail.ExpiresAt, now-3600+qqTTL)
	}
}

// ---- 5. 没有时间字段 → unknown,绝不猜成 expired ----
// 这条很关键:把"无法判断"误报成"已过期"会让用户白白去重新登录,
// 而把"已过期"报成"有效"会让音质悄悄下降 —— 两种都不可接受。
func TestQQCredentialWithoutTimestampIsUnknown(t *testing.T) {
	withFixedNow(t, 1_800_000_000)
	detail := BuildCookieStatusDetail("qq", "uin=1; musickey=T; qm_keyst=T", false)
	if detail.State != "unknown" {
		t.Fatalf("state = %q, want unknown", detail.State)
	}
	if detail.ExpiresAt != 0 {
		t.Fatalf("无法判断时不应编造 expires_at, got %d", detail.ExpiresAt)
	}
}

// ---- 6. 非 QQ 源:未知 / missing ----
func TestNonQQCredentialStates(t *testing.T) {
	t.Run("netease 有时间限制但只能探测 → 未探测时 unknown", func(t *testing.T) {
		detail := BuildCookieStatusDetail("netease", "MUSIC_U=abc", false)
		if detail.State != "unknown" {
			t.Fatalf("state = %q, want unknown", detail.State)
		}
		if detail.ExpirySource != "probe" {
			t.Fatalf("expiry_source = %q, want probe", detail.ExpirySource)
		}
	})
	t.Run("未配置 → missing", func(t *testing.T) {
		detail := BuildCookieStatusDetail("qq", "", false)
		if detail.State != "missing" {
			t.Fatalf("state = %q, want missing", detail.State)
		}
	})
	t.Run("没有过期能力的源 → unknown", func(t *testing.T) {
		detail := BuildCookieStatusDetail("bilibili", "SESSDATA=abc", false)
		if detail.State != "unknown" {
			t.Fatalf("state = %q, want unknown", detail.State)
		}
	})
}

// ---- 7. 安全:新字段绝不能泄露 cookie 内容 ----
func TestCredentialExpiryDoesNotLeakCookieValues(t *testing.T) {
	withFixedNow(t, 1_800_000_000)
	cookie := "uin=1; musickey=SUPER_SECRET_MUSIC_KEY; qm_keyst=SUPER_SECRET_MUSIC_KEY" +
		"; psrf_musickey_createtime=1799999000; keyexpiresin=259200"
	detail := BuildCookieStatusDetail("qq", cookie, false)
	raw, err := json.Marshal(detail)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(raw)
	if strings.Contains(body, "SUPER_SECRET_MUSIC_KEY") {
		t.Fatalf("status detail leaked cookie value: %s", body)
	}
	if !strings.Contains(body, `"state"`) || !strings.Contains(body, `"expiry_source"`) {
		t.Fatalf("新字段缺失: %s", body)
	}
}

// ---- 8. 探测失败必须覆盖时间戳推断(硬证据优先于软推断) ----
// 场景:时间戳显示"还剩 50 小时",但实际已被服务端吊销 ——
// 此时必须以探测结果为准标成 expired,否则用户看着"有效"却一直拿不到无损。
func TestProbeFailureOverridesTimestamp(t *testing.T) {
	const now = int64(1_800_000_000)
	withFixedNow(t, now)
	// 网易没有时间字段,这里直接验证 markCredentialExpired 的语义
	detail := CookieStatusDetail{State: "ok", ExpirySource: "musickey", ExpiresInSeconds: 50 * 3600}
	markCredentialExpired(&detail, "probe", "probe failed")
	if detail.State != "expired" {
		t.Fatalf("state = %q, want expired(探测失败必须覆盖时间戳推断)", detail.State)
	}
	if detail.ExpirySource != "probe" {
		t.Fatalf("expiry_source = %q, want probe", detail.ExpirySource)
	}
}

// ---- 9. 探测成功可纠正时钟偏差导致的误判 ----
func TestProbeSuccessCorrectsFalseExpiry(t *testing.T) {
	detail := CookieStatusDetail{State: "expired", ExpirySource: "musickey", ExpiresInSeconds: -100}
	markCredentialValid(&detail, "probe")
	if detail.State != "ok" {
		t.Fatalf("state = %q, want ok(探测成功说明凭证此刻可用)", detail.State)
	}
}
