package core

import "testing"

func TestQQQRLoginDefaultUsesStrongClientEntryAndKeepsConnectFallback(t *testing.T) {
	if GetQRLoginCreateFunc("qq") == nil || GetQRLoginCheckFunc("qq") == nil {
		t.Fatal("qq QR login funcs should be registered")
	}
	if GetQRLoginCreateFunc("qq_connect") == nil || GetQRLoginCheckFunc("qq_connect") == nil {
		t.Fatal("qq_connect QR login funcs should remain available as a fallback entry")
	}

	var hasQQ, hasQQConnect bool
	for _, source := range GetQRLoginSourceNames() {
		switch source {
		case "qq":
			hasQQ = true
		case "qq_connect":
			hasQQConnect = true
		}
	}
	if !hasQQ || !hasQQConnect {
		t.Fatalf("QR sources should include both qq and qq_connect, got %#v", GetQRLoginSourceNames())
	}
}
