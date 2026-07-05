package main

import "strings"

// regions.go — named metro areas for city filtering. Filtering by a region
// matches events tagged with the region name OR any member city (server-side
// expansion, no geocoding/zip-radius: zero external APIs, deterministic).
// Mirror additions in the web's REGIONS list (lib.tsx).
var regions = map[string][]string{
	"Bay Area, CA":          {"San Francisco", "Oakland", "San Jose", "Berkeley", "Palo Alto", "Mountain View", "Fremont", "Santa Clara", "Sunnyvale", "Redwood City"},
	"Orange County, CA":     {"Anaheim", "Irvine", "Santa Ana", "Huntington Beach", "Costa Mesa", "Fullerton", "Newport Beach", "Orange"},
	"Greater LA, CA":        {"Los Angeles", "Long Beach", "Pasadena", "Glendale", "Santa Monica", "Burbank", "Torrance"},
	"Inland Empire, CA":     {"Riverside", "San Bernardino", "Ontario", "Rancho Cucamonga", "Temecula"},
	"San Diego County, CA":  {"San Diego", "Chula Vista", "Oceanside", "Carlsbad", "Escondido"},
	"Sacramento Metro, CA":  {"Sacramento", "Roseville", "Folsom", "Elk Grove", "Davis"},
	"NYC Metro":             {"New York", "Brooklyn", "Queens", "Bronx", "Staten Island", "Jersey City", "Newark", "Hoboken", "Yonkers"},
	"Greater Boston, MA":    {"Boston", "Cambridge", "Somerville", "Brookline", "Quincy", "Newton"},
	"Philly Metro, PA":      {"Philadelphia", "Camden", "King of Prussia", "Cherry Hill"},
	"DC Metro (DMV)":        {"Washington", "Arlington", "Alexandria", "Bethesda", "Silver Spring", "Tysons"},
	"Chicagoland, IL":       {"Chicago", "Evanston", "Naperville", "Oak Park", "Schaumburg"},
	"Seattle Area, WA":      {"Seattle", "Bellevue", "Redmond", "Tacoma", "Kirkland", "Everett"},
	"Portland Metro, OR":    {"Portland", "Beaverton", "Hillsboro", "Gresham", "Vancouver WA"},
	"Denver Metro, CO":      {"Denver", "Boulder", "Aurora", "Lakewood", "Littleton"},
	"Phoenix Valley, AZ":    {"Phoenix", "Scottsdale", "Tempe", "Mesa", "Chandler", "Gilbert", "Glendale AZ"},
	"Salt Lake Valley, UT":  {"Salt Lake City", "Provo", "Sandy", "West Valley City", "Lehi"},
	"Las Vegas Valley, NV":  {"Las Vegas", "Henderson", "North Las Vegas", "Summerlin"},
	"DFW, TX":               {"Dallas", "Fort Worth", "Arlington TX", "Plano", "Irving", "Frisco"},
	"Houston Metro, TX":     {"Houston", "Sugar Land", "The Woodlands", "Katy", "Pearland"},
	"Austin Metro, TX":      {"Austin", "Round Rock", "Cedar Park", "Pflugerville"},
	"Twin Cities, MN":       {"Minneapolis", "St. Paul", "Bloomington", "Edina"},
	"Detroit Metro, MI":     {"Detroit", "Ann Arbor", "Dearborn", "Royal Oak", "Troy"},
	"Atlanta Metro, GA":     {"Atlanta", "Decatur", "Marietta", "Alpharetta", "Sandy Springs"},
	"South Florida":         {"Miami", "Fort Lauderdale", "West Palm Beach", "Boca Raton", "Hollywood FL"},
	"Tampa Bay, FL":         {"Tampa", "St. Petersburg", "Clearwater", "Brandon"},
	"Research Triangle, NC": {"Raleigh", "Durham", "Chapel Hill", "Cary"},
}

// expandCityFilter turns a city query into ILIKE patterns: a region expands to
// itself + all member cities; anything else is a plain contains-match.
func expandCityFilter(city string) []string {
	city = strings.TrimSpace(city)
	if city == "" {
		return []string{}
	}
	for name, members := range regions {
		if strings.EqualFold(name, city) {
			out := []string{"%" + name + "%"}
			for _, m := range members {
				out = append(out, "%"+m+"%")
			}
			return out
		}
	}
	return []string{"%" + city + "%"}
}
