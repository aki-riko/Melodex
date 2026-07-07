package qq

import "testing"

func TestQQCredentialFromCookieFallsBackToZeroUIN(t *testing.T) {
	uin, key := qqCredentialFromCookie("qm_keyst=KEY")
	if uin != "0" {
		t.Fatalf("uin = %q, want 0", uin)
	}
	if key != "KEY" {
		t.Fatalf("key = %q, want KEY", key)
	}
}
