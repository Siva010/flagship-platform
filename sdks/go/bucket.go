package flagship

// BucketSpace is the size of the bucket range. Every SDK must agree on it.
const BucketSpace uint32 = 100000

// bucketSeparator is never escaped; keys are restricted to [a-zA-Z0-9._-] at write time.
const bucketSeparator = ":"

// BucketingInput joins the hash input. Exported so drift between the joiner and
// the hasher is impossible to introduce accidentally.
func BucketingInput(flagKey, salt, bucketKey string) string {
	return flagKey + bucketSeparator + salt + bucketSeparator + bucketKey
}

// BucketFor maps a user to a stable point in [0, BucketSpace).
func BucketFor(flagKey, salt, bucketKey string) uint32 {
	return MurmurHash3String(BucketingInput(flagKey, salt, bucketKey), 0) % BucketSpace
}

// Distribution is one slice of a percentage rollout. Weights are in basis points
// of BucketSpace and must sum to exactly BucketSpace.
type Distribution struct {
	VariationKey string `json:"variationKey"`
	Weight       uint32 `json:"weight"`
}

// VariationForBucket walks the distribution in declaration order and serves the
// first variation whose cumulative weight exceeds the bucket.
//
// Declaration order is part of the wire contract: it is what makes raising a
// rollout from 10% to 20% additive, so nobody already inside it moves.
//
// Returns ok=false for a malformed distribution; callers fall back to the
// default variation.
func VariationForBucket(distribution []Distribution, bucket uint32) (key string, ok bool) {
	var cumulative uint32
	for _, entry := range distribution {
		cumulative += entry.Weight
		if bucket < cumulative {
			return entry.VariationKey, true
		}
	}
	return "", false
}
