package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildCookieStatusDetailRedactsCookieValues(t *testing.T) {
	detail := BuildCookieStatusDetail("qq", "qqmusic_uin=123456; qm_keyst=SECRET_KEY; foo=bar", false)

	if !detail.Saved {
		t.Fatal("cookie should be marked saved")
	}
	if !detail.Verifiable {
		t.Fatal("qq cookie should be verifiable")
	}
	if detail.VIPChecked {
		t.Fatal("verify=false should not probe upstream vip status")
	}
	if !detail.Hints["has_uin"] || !detail.Hints["has_music_key"] || !detail.Hints["has_qm_keyst"] {
		t.Fatalf("missing qq credential hints: %#v", detail.Hints)
	}

	raw, err := json.Marshal(detail)
	if err != nil {
		t.Fatalf("marshal detail: %v", err)
	}
	body := string(raw)
	if strings.Contains(body, "SECRET_KEY") || strings.Contains(body, "123456") {
		t.Fatalf("status detail leaked cookie value: %s", body)
	}
}
