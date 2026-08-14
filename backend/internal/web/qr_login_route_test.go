package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
	"github.com/gin-gonic/gin"
)

func withQRLoginRouteHooks(t *testing.T) {
	t.Helper()
	originalStarter := resolveLoginStarter
	originalPoller := resolveLoginPoller
	originalStore := storeProviderCookie
	t.Cleanup(func() {
		resolveLoginStarter = originalStarter
		resolveLoginPoller = originalPoller
		storeProviderCookie = originalStore
	})
}

func newQRLoginRouteTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterQRLoginRoutes(router.Group(RoutePrefix))
	return router
}

func TestQRLoginRouteStartsChallenge(t *testing.T) {
	withQRLoginRouteHooks(t)
	resolveLoginStarter = func(provider string) core.QRLoginCreateFunc {
		if provider != "netease" {
			t.Fatalf("provider = %q, want netease", provider)
		}
		return func() (*model.LoginChallenge, error) {
			return &model.LoginChallenge{Provider: provider, ChallengeID: "challenge-1"}, nil
		}
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, RoutePrefix+"/qr_login/netease", nil)
	newQRLoginRouteTestRouter().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var challenge model.LoginChallenge
	if err := json.Unmarshal(recorder.Body.Bytes(), &challenge); err != nil {
		t.Fatalf("decode challenge: %v", err)
	}
	if challenge.ChallengeID != "challenge-1" {
		t.Fatalf("challenge key = %q, want challenge-1", challenge.ChallengeID)
	}
}

func TestQRLoginRoutePersistsSuccessfulCookie(t *testing.T) {
	withQRLoginRouteHooks(t)
	resolveLoginPoller = func(provider string) core.QRLoginCheckFunc {
		return func(challengeID string) (*model.LoginResult, error) {
			if challengeID != "challenge-1" {
				t.Fatalf("challengeID = %q, want challenge-1", challengeID)
			}
			return &model.LoginResult{
				Provider: provider,
				Phase:    model.LoginSucceeded,
				CookieValues: map[string]string{
					"zeta":  "last",
					"alpha": "first",
				},
			}, nil
		}
	}
	var storedProvider, storedCookie string
	storeProviderCookie = func(provider, cookie string) {
		storedProvider, storedCookie = provider, cookie
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, RoutePrefix+"/qr_login/netease?key=challenge-1", nil)
	newQRLoginRouteTestRouter().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if storedProvider != "netease" || storedCookie != "alpha=first; zeta=last" {
		t.Fatalf("stored provider/cookie = %q/%q", storedProvider, storedCookie)
	}

	var result model.LoginResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.Metadata["cookie_saved"] != "true" || result.Metadata["cookie_source"] != "netease" {
		t.Fatalf("metadata = %#v", result.Metadata)
	}
}

func TestQRLoginRouteDoesNotPersistWaitingResult(t *testing.T) {
	withQRLoginRouteHooks(t)
	resolveLoginPoller = func(string) core.QRLoginCheckFunc {
		return func(string) (*model.LoginResult, error) {
			return &model.LoginResult{Phase: model.LoginWaiting, RawCookie: "secret=unused"}, nil
		}
	}
	storeProviderCookie = func(string, string) {
		t.Fatal("waiting login must not persist a cookie")
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, RoutePrefix+"/qr_login/netease?key=challenge-1", nil)
	newQRLoginRouteTestRouter().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
}

func TestQRLoginRouteValidatesProviderAndKey(t *testing.T) {
	withQRLoginRouteHooks(t)
	resolveLoginStarter = func(string) core.QRLoginCreateFunc { return nil }
	resolveLoginPoller = func(string) core.QRLoginCheckFunc { return nil }
	router := newQRLoginRouteTestRouter()

	for _, test := range []struct {
		method string
		path   string
		want   int
	}{
		{method: http.MethodPost, path: RoutePrefix + "/qr_login/unknown", want: http.StatusNotFound},
		{method: http.MethodGet, path: RoutePrefix + "/qr_login/netease", want: http.StatusBadRequest},
		{method: http.MethodGet, path: RoutePrefix + "/qr_login/unknown?key=x", want: http.StatusNotFound},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, test.path, nil)
		router.ServeHTTP(recorder, request)
		if recorder.Code != test.want {
			t.Fatalf("%s %s status = %d, want %d", test.method, test.path, recorder.Code, test.want)
		}
	}
}
