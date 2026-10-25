package core

// 用生产真实 cookie 形态验证有效期推算(不含任何真实凭据,只构造等价字段)。
// 这是补充验证:单元测试用的是合成时间戳,这里用"实测到的真实字段组合"再核一遍。

import (
	"testing"
	"time"
)

func TestQQCredentialWithRealWorldShape(t *testing.T) {
	// 2026-10-25 生产实测到的真实值(注意三个字段语义不同!):
	//   psrf_musickey_createtime = 1792859361  (2026-10-25 00:29:21)
	//   keyexpiresin             = 259200      (3 天 → 到期 2026-10-28)
	//   expired_at               = 1798043361  (2026-12-24 = 创建 + 60 天,另一套 token)
	// 必须只认 keyexpiresin —— 用 expired_at 会把"3 天"错报成"60 天"。
	const created = int64(1792859361)
	const ttl = int64(259200)
	const expiredAtOtherToken = int64(1798043361)
	const expectedExpiry = created + ttl

	cookie := "uin=0123456789; str_musicid=0123456789; qqmusic_uin=0123456789; musicid=0123456789" +
		"; musickey=REAL_SHAPE_TOKEN; qqmusic_key=REAL_SHAPE_TOKEN; qm_keyst=REAL_SHAPE_TOKEN" +
		"; psrf_musickey_createtime=" + itoa(created) +
		"; musickeycreatetime=" + itoa(created) +
		"; keyexpiresin=" + itoa(ttl) +
		"; expired_at=" + itoa(expiredAtOtherToken) +
		"; psrf_qqrefresh_token=REFRESHSTUB; psrf_qqunionid=UNIONSTUB"

	// 情形 A:在创建后 20.1 小时(即实测那一刻)
	withFixedNow(t, created+int64(20.1*3600))
	detail := BuildCookieStatusDetail("qq", cookie, false)
	if detail.ExpiresAt != expectedExpiry {
		t.Fatalf("expires_at = %d, want %d(按 keyexpiresin,不是 expired_at)", detail.ExpiresAt, expectedExpiry)
	}
	if detail.State != "ok" {
		t.Fatalf("创建后 20h 应为 ok, got %q (剩余 %d 秒)", detail.State, detail.ExpiresInSeconds)
	}
	remainHours := float64(detail.ExpiresInSeconds) / 3600
	if remainHours < 51 || remainHours > 53 {
		t.Fatalf("剩余应约 52h, got %.1fh", remainHours)
	}

	// 情形 B:过期后 1 小时
	withFixedNow(t, expectedExpiry+3600)
	expired := BuildCookieStatusDetail("qq", cookie, false)
	if expired.State != "expired" {
		t.Fatalf("过期后应为 expired, got %q", expired.State)
	}

	// 情形 C:剩余 12h(应 expiring_soon,提醒用户去重登)
	withFixedNow(t, expectedExpiry-int64(12*3600))
	soon := BuildCookieStatusDetail("qq", cookie, false)
	if soon.State != "expiring_soon" {
		t.Fatalf("剩余 12h 应为 expiring_soon, got %q", soon.State)
	}

	// 输出一份人类可读的结论,便于人工核对
	withFixedNow(t, time.Now().Unix())
	now := BuildCookieStatusDetail("qq", cookie, false)
	stateText := map[string]string{
		"ok": "有效", "expiring_soon": "即将过期", "expired": "已过期",
		"unknown": "无法判断", "missing": "未配置",
	}[now.State]
	remainH := float64(now.ExpiresInSeconds) / 3600
	t.Logf("按真实字段形态(创建 %d + keyexpiresin %ds)在当刻的判定: %s, 剩余 %.1f 小时",
		created, ttl, stateText, remainH)
}
