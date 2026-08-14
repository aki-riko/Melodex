package model

import (
	"encoding/json"
	"testing"
)

func TestLoginPhaseJSONContract(t *testing.T) {
	for phase, want := range map[LoginPhase]string{
		LoginWaiting:   `"waiting"`,
		LoginScanned:   `"scanned"`,
		LoginSucceeded: `"success"`,
		LoginExpired:   `"expired"`,
		LoginFailed:    `"failed"`,
	} {
		encoded, err := json.Marshal(phase)
		if err != nil {
			t.Fatalf("marshal %v: %v", phase, err)
		}
		if string(encoded) != want {
			t.Fatalf("marshal %v = %s, want %s", phase, encoded, want)
		}

		var decoded LoginPhase
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("unmarshal %s: %v", encoded, err)
		}
		if decoded != phase {
			t.Fatalf("unmarshal %s = %v, want %v", encoded, decoded, phase)
		}
	}
}

func TestLoginPhaseRejectsUnknownValue(t *testing.T) {
	var phase LoginPhase
	if err := json.Unmarshal([]byte(`"complete"`), &phase); err == nil {
		t.Fatal("unknown login phase was accepted")
	}
}
