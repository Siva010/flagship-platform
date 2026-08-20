package flagship

import "math/bits"

// MurmurHash3 x86_32. Must agree byte-for-byte with the TypeScript and Java
// SDKs — see spec/BUCKETING.md.
//
// Go needs none of the defensive masking the JavaScript port requires: uint32
// arithmetic wraps natively, and a Go string is already UTF-8, so []byte(s)
// yields exactly the bytes the spec calls for.
const (
	c1 uint32 = 0xcc9e2d51
	c2 uint32 = 0x1b873593
)

func murmurHash3x86_32(data []byte, seed uint32) uint32 {
	h1 := seed
	nblocks := len(data) / 4

	for i := 0; i < nblocks; i++ {
		o := i * 4
		k1 := uint32(data[o]) |
			uint32(data[o+1])<<8 |
			uint32(data[o+2])<<16 |
			uint32(data[o+3])<<24

		k1 *= c1
		k1 = bits.RotateLeft32(k1, 15)
		k1 *= c2

		h1 ^= k1
		h1 = bits.RotateLeft32(h1, 13)
		h1 = h1*5 + 0xe6546b64
	}

	// Tail: 0-3 bytes that did not fill a block. Fallthrough is deliberate.
	tail := data[nblocks*4:]
	var k1 uint32
	switch len(tail) {
	case 3:
		k1 ^= uint32(tail[2]) << 16
		fallthrough
	case 2:
		k1 ^= uint32(tail[1]) << 8
		fallthrough
	case 1:
		k1 ^= uint32(tail[0])
		k1 *= c1
		k1 = bits.RotateLeft32(k1, 15)
		k1 *= c2
		h1 ^= k1
	}

	// Finalization mix.
	h1 ^= uint32(len(data))
	h1 ^= h1 >> 16
	h1 *= 0x85ebca6b
	h1 ^= h1 >> 13
	h1 *= 0xc2b2ae35
	h1 ^= h1 >> 16

	return h1
}

// MurmurHash3String hashes a string's UTF-8 bytes.
func MurmurHash3String(input string, seed uint32) uint32 {
	return murmurHash3x86_32([]byte(input), seed)
}
