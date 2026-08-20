// Package flagship is the in-process Go SDK.
//
// Evaluation is local: the client holds the full ruleset in memory and never
// performs network I/O on the hot path. See spec/BUCKETING.md for the bucketing
// contract this package must satisfy.
package flagship
