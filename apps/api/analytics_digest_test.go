package main

import "testing"

// The free-tier runway bar for Neon compute is only as trustworthy as this
// arithmetic: both sources land in CU-hours against the 100/month limit.

func TestCUHoursFromComputeSeconds(t *testing.T) {
	cases := []struct {
		sec  float64
		want float64
	}{
		{0, 0},
		{3600, 1},     // 1 CU-hour
		{900, 0.25},   // 1h at 0.25 CU is billed as 900 CU-seconds
		{360000, 100}, // exactly the free limit
		{1800, 0.5},
	}
	for _, c := range cases {
		if got := cuHoursFromComputeSeconds(c.sec); got != c.want {
			t.Errorf("cuHoursFromComputeSeconds(%v) = %v, want %v", c.sec, got, c.want)
		}
	}
}

func TestCUHoursFromAwakeBuckets(t *testing.T) {
	cases := []struct {
		buckets, mins int
		size, want    float64
	}{
		{0, 5, 0.25, 0},
		{-3, 5, 0.25, 0},    // a failed HogQL scalar returns 0, never negative work
		{12, 5, 0.25, 0.25}, // 12 buckets = 1 awake hour = 0.25 CU-hours
		{12, 5, 1, 1},       // same hour on a 1 CU compute
		{1200, 5, 0.25, 25}, // ~100 awake hours a month
		{24, 0, 0.25, 0},    // guard against a zero bucket width
	}
	for _, c := range cases {
		if got := cuHoursFromAwakeBuckets(c.buckets, c.mins, c.size); got != c.want {
			t.Errorf("cuHoursFromAwakeBuckets(%d, %d, %v) = %v, want %v", c.buckets, c.mins, c.size, got, c.want)
		}
	}
}
