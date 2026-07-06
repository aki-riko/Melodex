package web

import "testing"

func TestEnvPositiveInt(t *testing.T) {
	const key = "MUSIC_DL_TEST_POSITIVE_INT"

	if got := envPositiveInt(key, 7); got != 7 {
		t.Fatalf("unset env = %d, want fallback 7", got)
	}

	for _, raw := range []string{"", "0", "-1", "not-a-number"} {
		t.Setenv(key, raw)
		if got := envPositiveInt(key, 7); got != 7 {
			t.Fatalf("env %q = %d, want fallback 7", raw, got)
		}
	}

	t.Setenv(key, "12")
	if got := envPositiveInt(key, 7); got != 12 {
		t.Fatalf("valid env = %d, want 12", got)
	}
}
