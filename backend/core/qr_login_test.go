package core

import (
	"reflect"
	"testing"

	"github.com/guohuiyuan/music-lib/qq"
)

func TestQQQRLoginDefaultUsesStrongClientEntryAndKeepsConnectFallback(t *testing.T) {
	if GetQRLoginCreateFunc("qq") == nil || GetQRLoginCheckFunc("qq") == nil {
		t.Fatal("qq QR login funcs should be registered")
	}
	if reflect.ValueOf(GetQRLoginCreateFunc("qq")).Pointer() != reflect.ValueOf(qq.CreateMobileQRLogin).Pointer() {
		t.Fatal("qq QR login should use the strong QQ Music client entry by default")
	}
	if reflect.ValueOf(GetQRLoginCheckFunc("qq")).Pointer() != reflect.ValueOf(qq.CheckMobileQRLogin).Pointer() {
		t.Fatal("qq QR login check should use the strong QQ Music client entry by default")
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
