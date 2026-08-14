package fileutil

import "testing"

func TestSanitizeFilenamePreservesLegacyContract(t *testing.T) {
	if got := SanitizeFilename(`  a\\b/c:*?"<>|  `); got != "a__b_c_______" {
		t.Fatalf("SanitizeFilename() = %q", got)
	}
	if got := SanitizeFilename("   "); got != "unknown" {
		t.Fatalf("empty filename = %q", got)
	}
}
