package main

import "testing"

// seriesKey must map every decoration UCB puts on a recurring show's title
// back to the same key as the plain title our group events carry.
func TestSeriesKey(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Club 401: A Harold Jam", "club 401"},
		{"club 401", "club 401"},
		{"ONE BIG JAM!", "one big jam"},
		{"Strawberry Jam (Ladies Night)", "strawberry jam"},
		{"Strawberry Jam, hosted by “Ladies Night”", "strawberry jam"},
		{"Harold Night ft. S.O.F.T. & Branzino", "harold night"},
		{"Harold Night ft. Cowboy Mama & Dance Club Remix", "harold night"},
		{"Sketch Jam", "sketch jam"},
		{"Musical Improv Jam", "musical improv jam"},
		{"Asian AF Jam", "asian af jam"},
		{"  Asian  AF   Jam  ", "asian af jam"},
	}
	for _, c := range cases {
		if got := seriesKey(c.in); got != c.want {
			t.Errorf("seriesKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
