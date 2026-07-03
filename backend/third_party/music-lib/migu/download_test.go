package migu

import "testing"

func TestPreferredMiguFormatCandidatesHighToLow(t *testing.T) {
	got := preferredMiguFormatCandidates([]miguRateFormat{
		{ResourceType: "2", FormatType: "PQ", Size: "4000000"},
		{ResourceType: "2", FormatType: "SQ", Size: "32000000"},
		{ResourceType: "2", FormatType: "HQ", Size: "10000000"},
		{ResourceType: "2", FormatType: "ZQ", Size: "64000000"},
	})
	want := []string{"ZQ", "SQ", "HQ", "PQ"}
	if len(got) != len(want) {
		t.Fatalf("candidate count = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].FormatType != want[i] {
			t.Fatalf("candidate[%d] = %q, want %q", i, got[i].FormatType, want[i])
		}
	}
}

func TestMiguFormatCandidateRoundTripAndAppend(t *testing.T) {
	encoded := encodeMiguFormatCandidates([]miguFormatCandidate{
		{ResourceType: "2", FormatType: "SQ"},
		{ResourceType: "2", FormatType: "HQ"},
	})
	if encoded != "2|SQ,2|HQ" {
		t.Fatalf("encoded = %q, want 2|SQ,2|HQ", encoded)
	}

	decoded := decodeMiguFormatCandidates(encoded + ",bad,2|SQ")
	if len(decoded) != 2 {
		t.Fatalf("decoded count = %d, want 2", len(decoded))
	}
	if decoded[0].FormatType != "SQ" || decoded[1].FormatType != "HQ" {
		t.Fatalf("decoded order = %#v", decoded)
	}

	appended := appendMiguFormatCandidate(decoded, "2", "PQ")
	appended = appendMiguFormatCandidate(appended, "2", "HQ")
	if len(appended) != 3 {
		t.Fatalf("appended count = %d, want 3", len(appended))
	}
	if appended[2].FormatType != "PQ" {
		t.Fatalf("last appended candidate = %q, want PQ", appended[2].FormatType)
	}
}
