package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

// TestQRLoginUsesProviderBridgeForEverySource 锁定扫码登录的来源边界。
//
// 2026-08-15 的 d222a0c(后端来源脱钩)把 music-lib 的 QQ 扫码一起删了, 当时这条线是靠
// "名单里不许有 qq" 守住的(qq 那时只能靠被删掉的 Go provider 实现)。QQ 扫码现在由
// provider_bridge/qq_login.py 原生重建(ptlogin2 扫码 + QQ 互联强凭证, 不依赖被删的
// provider), 所以断言换成真正的不变量: **名单里的每个源都必须经 provider bridge 实现**,
// 未实现的源仍然必须是 nil(界面上"扫码"按钮显不显示由这个名单决定)。
func TestQRLoginUsesProviderBridgeForEverySource(t *testing.T) {
	resetProviderBridgeStateForTest()
	defer resetProviderBridgeStateForTest()

	var paths []string
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"challenge":{"source":"qq","key":"KEY"}}`))
	}))
	defer server.Close()
	t.Setenv(providerBridgeURLEnv, server.URL)

	for _, source := range []string{"netease", "qq"} {
		create := GetQRLoginCreateFunc(source)
		if create == nil {
			t.Fatalf("%s QR create func should be registered", source)
		}
		if _, err := create(); err != nil {
			t.Fatalf("%s QR create through provider bridge failed: %v", source, err)
		}
		if GetQRLoginCheckFunc(source) == nil {
			t.Fatalf("%s QR check func should be registered", source)
		}
	}
	if len(paths) != 2 {
		t.Fatalf("provider bridge calls = %d, want 2", len(paths))
	}
	for index, path := range paths {
		if path != "/v1/qr/create" {
			t.Fatalf("call %d path = %q, want /v1/qr/create", index, path)
		}
	}
	if got := bodies[1]["source"]; got != "qq" {
		t.Fatalf("qq QR create source = %v, want qq", got)
	}
	if got := bodies[0]["source"]; got != "netease" {
		t.Fatalf("netease QR create source = %v, want netease", got)
	}

	// 没有扫码实现的源(如酷狗)必须继续返回 nil, 否则界面会显示一个点了没用的按钮。
	if GetQRLoginCreateFunc("kugou") != nil || GetQRLoginCheckFunc("kugou") != nil {
		t.Fatal("kugou has no QR login implementation and must stay unexposed")
	}

	names := GetQRLoginSourceNames()
	if len(names) != 2 || !slices.Contains(names, "netease") || !slices.Contains(names, "qq") {
		t.Fatalf("QR sources = %v, want [netease qq]", names)
	}
}
