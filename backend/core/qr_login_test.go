package core

import (
	"reflect"
	"testing"

	"github.com/guohuiyuan/music-lib/qq"
)

func TestQQQRLoginDefaultAndMobileFallbackAreAvailable(t *testing.T) {
	if GetQRLoginCreateFunc("qq") == nil || GetQRLoginCheckFunc("qq") == nil {
		t.Fatal("qq QR login funcs should be registered")
	}
	if reflect.ValueOf(GetQRLoginCreateFunc("qq")).Pointer() != reflect.ValueOf(qq.CreateQRLogin).Pointer() {
		t.Fatal("qq QR login should use the stable QQ Connect entry by default")
	}
	if reflect.ValueOf(GetQRLoginCheckFunc("qq")).Pointer() != reflect.ValueOf(qq.CheckQRLogin).Pointer() {
		t.Fatal("qq QR login check should use the stable QQ Connect entry by default")
	}
	if GetQRLoginCreateFunc("qq_mobile") == nil || GetQRLoginCheckFunc("qq_mobile") == nil {
		t.Fatal("qq_mobile QR login funcs should remain available as a fallback entry")
	}

	var hasQQ, hasQQMobile bool
	for _, source := range GetQRLoginSourceNames() {
		switch source {
		case "qq":
			hasQQ = true
		case "qq_mobile":
			hasQQMobile = true
		}
	}
	if !hasQQ || !hasQQMobile {
		t.Fatalf("QR sources should include both qq and qq_mobile, got %#v", GetQRLoginSourceNames())
	}
}
