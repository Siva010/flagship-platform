package flagship

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const fixtureRelPath = "../../spec/conformance/bucketing.json"

type conformanceCase struct {
	FlagKey        string `json:"flagKey"`
	Salt           string `json:"salt"`
	BucketKey      string `json:"bucketKey"`
	Input          string `json:"input"`
	Hash           uint32 `json:"hash"`
	ExpectedBucket uint32 `json:"expectedBucket"`
}

type conformanceFixture struct {
	Version     int               `json:"version"`
	Algorithm   string            `json:"algorithm"`
	BucketSpace uint32            `json:"bucketSpace"`
	Cases       []conformanceCase `json:"cases"`
}

func loadFixture(t *testing.T) conformanceFixture {
	t.Helper()

	raw, err := os.ReadFile(filepath.FromSlash(fixtureRelPath))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var fixture conformanceFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("fixture contains no cases; regenerate it with `npm run fixture:generate`")
	}
	return fixture
}

// TestConformanceBucketing is the cross-language gate. It must agree with the
// TypeScript reference implementation on every case, or the SDKs have drifted.
func TestConformanceBucketing(t *testing.T) {
	fixture := loadFixture(t)

	if fixture.BucketSpace != BucketSpace {
		t.Fatalf("bucket space mismatch: fixture=%d sdk=%d", fixture.BucketSpace, BucketSpace)
	}

	for _, tc := range fixture.Cases {
		if got := BucketingInput(tc.FlagKey, tc.Salt, tc.BucketKey); got != tc.Input {
			t.Errorf("input mismatch:\n  flagKey=%q salt=%q bucketKey=%q\n  got  %q\n  want %q",
				tc.FlagKey, tc.Salt, tc.BucketKey, got, tc.Input)
			continue
		}
		if got := MurmurHash3String(tc.Input, 0); got != tc.Hash {
			t.Errorf("hash mismatch for %q: got %d, want %d", tc.Input, got, tc.Hash)
			continue
		}
		if got := BucketFor(tc.FlagKey, tc.Salt, tc.BucketKey); got != tc.ExpectedBucket {
			t.Errorf("bucket mismatch for %q: got %d, want %d", tc.Input, got, tc.ExpectedBucket)
		}
	}

	t.Logf("verified %d conformance cases", len(fixture.Cases))
}

// TestMurmurReferenceVectors checks the port against published vectors rather
// than only against the fixture, so a shared misunderstanding between the two
// implementations cannot pass unnoticed.
func TestMurmurReferenceVectors(t *testing.T) {
	vectors := []struct {
		input string
		want  uint32
	}{
		{"", 0},
		{"a", 0x3c2569b2},
		{"ab", 0x9bbfd75f},
		{"abc", 0xb3dd93fa},
		{"abcd", 0x43ed676a},
		{"Hello, world!", 0xc0363e43},
	}
	for _, v := range vectors {
		if got := MurmurHash3String(v.input, 0); got != v.want {
			t.Errorf("MurmurHash3String(%q) = %#x, want %#x", v.input, got, v.want)
		}
	}
}

func TestVariationForBucket(t *testing.T) {
	even := []Distribution{
		{VariationKey: "control", Weight: 50000},
		{VariationKey: "treatment", Weight: 50000},
	}

	cases := []struct {
		bucket uint32
		want   string
	}{
		{0, "control"},
		{49999, "control"},
		{50000, "treatment"},
		{99999, "treatment"},
	}
	for _, tc := range cases {
		got, ok := VariationForBucket(even, tc.bucket)
		if !ok || got != tc.want {
			t.Errorf("VariationForBucket(bucket=%d) = %q,%v; want %q,true", tc.bucket, got, ok, tc.want)
		}
	}

	if _, ok := VariationForBucket(nil, 0); ok {
		t.Error("empty distribution should report ok=false")
	}
}
