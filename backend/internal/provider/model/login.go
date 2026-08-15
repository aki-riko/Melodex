package model

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// LoginPhase is the provider-neutral state of an interactive login attempt.
type LoginPhase uint8

const (
	LoginWaiting LoginPhase = iota
	LoginScanned
	LoginSucceeded
	LoginExpired
	LoginFailed
)

var loginPhaseNames = [...]string{"waiting", "scanned", "success", "expired", "failed"}

func (phase LoginPhase) String() string {
	if int(phase) >= len(loginPhaseNames) {
		return "failed"
	}
	return loginPhaseNames[phase]
}

func (phase LoginPhase) MarshalJSON() ([]byte, error) {
	return json.Marshal(phase.String())
}

func (phase *LoginPhase) UnmarshalJSON(raw []byte) error {
	var name string
	if err := json.Unmarshal(raw, &name); err != nil {
		return err
	}
	for candidate, value := range loginPhaseNames {
		if bytes.EqualFold([]byte(name), []byte(value)) {
			*phase = LoginPhase(candidate)
			return nil
		}
	}
	return fmt.Errorf("unknown login phase %q", name)
}

// LoginChallenge contains the public data needed to complete a provider login.
type LoginChallenge struct {
	Provider        string            `json:"source"`
	ChallengeID     string            `json:"key"`
	VerificationURL string            `json:"url"`
	QRImageURL      string            `json:"image_url,omitempty"`
	StateToken      string            `json:"state,omitempty"`
	ExpiresUnix     int64             `json:"expires_at,omitempty"`
	Metadata        map[string]string `json:"extra,omitempty"`
}

// LoginResult is returned when polling an interactive provider login.
type LoginResult struct {
	Provider     string            `json:"source"`
	ChallengeID  string            `json:"key"`
	Phase        LoginPhase        `json:"status"`
	Detail       string            `json:"message,omitempty"`
	RawCookie    string            `json:"cookie,omitempty"`
	CookieValues map[string]string `json:"cookies,omitempty"`
	Metadata     map[string]string `json:"extra,omitempty"`
}
