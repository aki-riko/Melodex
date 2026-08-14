package core

import "testing"

func TestQRLoginOnlyExposesIndependentProviders(t *testing.T) {
	if GetQRLoginCreateFunc("netease") == nil || GetQRLoginCheckFunc("netease") == nil {
		t.Fatal("netease QR login funcs should be registered")
	}
	if GetQRLoginCreateFunc("qq") != nil || GetQRLoginCheckFunc("qq") != nil {
		t.Fatal("qq QR login must not depend on the removed provider")
	}

	var hasNetease bool
	for _, source := range GetQRLoginSourceNames() {
		if source == "netease" {
			hasNetease = true
		}
	}
	if !hasNetease {
		t.Fatalf("QR sources should include netease, got %#v", GetQRLoginSourceNames())
	}
}
