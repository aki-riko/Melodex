package web

import (
	"testing"
)

func TestUserPrefsIsolationAndDefaults(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1", RoleUser)

	// 默认:无记录时回退全局默认。
	def := getUserPref(alice.ID)
	if def.WebPageSize <= 0 {
		t.Fatalf("default WebPageSize should be positive, got %d", def.WebPageSize)
	}
	if def.DisableFloatingLyrics {
		t.Fatal("default DisableFloatingLyrics should be false")
	}

	// alice 改偏好。
	if err := saveUserPref(alice.ID, UserPref{DisableFloatingLyrics: true, WebPageSize: 50}); err != nil {
		t.Fatalf("saveUserPref alice: %v", err)
	}
	a := getUserPref(alice.ID)
	if !a.DisableFloatingLyrics || a.WebPageSize != 50 {
		t.Fatalf("alice pref not persisted: %+v", a)
	}

	// bob 不受影响(仍是默认)。
	b := getUserPref(bob.ID)
	if b.DisableFloatingLyrics || b.WebPageSize == 50 {
		t.Fatalf("bob pref should be default, got %+v", b)
	}

	// effectiveSettingsForUser 合并:alice 的两字段被覆盖,其余系统级不变。
	eff := effectiveSettingsForUser(alice.ID)
	if !eff.DisableFloatingLyrics || eff.WebPageSize != 50 {
		t.Fatalf("effective settings not merged for alice: floaty=%v size=%d", eff.DisableFloatingLyrics, eff.WebPageSize)
	}

	// WebPageSize 上限保护。
	if err := saveUserPref(alice.ID, UserPref{WebPageSize: 99999}); err != nil {
		t.Fatalf("saveUserPref clamp: %v", err)
	}
	if got := getUserPref(alice.ID); got.WebPageSize != 200 {
		t.Fatalf("WebPageSize should clamp to 200, got %d", got.WebPageSize)
	}
}
