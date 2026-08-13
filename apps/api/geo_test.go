package main

import "testing"

func TestGeoLabel(t *testing.T) {
	cases := []struct {
		name, house, street, city, state, postcode, country, want string
	}{
		{"", "123", "Main St", "Brooklyn", "NY", "11201", "United States", "123 Main St, Brooklyn, NY 11201, United States"},
		{"Central Park", "", "", "New York", "NY", "", "United States", "Central Park, New York, NY, United States"},
		{"", "", "Elm St", "", "", "", "", "Elm St"},
	}
	for _, c := range cases {
		if got := geoLabel(c.name, c.house, c.street, c.city, c.state, c.postcode, c.country); got != c.want {
			t.Errorf("geoLabel(%q…) = %q, want %q", c.name, got, c.want)
		}
	}
}
