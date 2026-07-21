package main

// venuesync.go - the shared engine that keeps a group's events in step with a
// venue's authoritative schedule. Two callers use it:
//
//   - ucbsync.go   : UCB posts pre-scraped shows (needs a browser for their
//                    Cloudflare challenge, so the parse lives outside the app).
//   - wgissync.go  : WGIS exposes a clean JSON feed, so the app fetches +
//                    parses it server-side - no scraper, no browser.
//
// Both feed the SAME reconciliation: per series (matched by seriesKey),
//   - adopt   : re-host matched occurrences to the venue bot; the previous
//               host stays on as cohost (keeps manage powers in the UI).
//   - create  : (autoCreate only) a title the group doesn't have yet becomes a
//               new series straight from the feed - content, cover, cohost the
//               group owner so they keep control. UCB leaves this OFF so a broad
//               scrape can't flood the group; WGIS turns it ON (a curated jam
//               feed from one theatre).
//   - add     : feed dates the series lacks become sibling occurrences.
//   - retime  : same calendar day, new clock time -> move + re-arm reminder.
//   - cancel  : a future occurrence the feed dropped, INSIDE the observed date
//               window -> quiet soft-cancel (no email; feed-absence is weaker
//               evidence than a host's explicit cancel).
//
// Idempotent: re-running with the same feed is a no-op.

import (
	"context"
	"strings"
	"time"

	"github.com/clsandbox/api/internal/db"

	"github.com/jackc/pgx/v5/pgtype"
)

// seriesKey normalizes a show title to the recurring series it belongs to:
// lowercased, cut at the first guest/subtitle separator, punctuation dropped.
// Venues decorate titles per occurrence ("Strawberry Jam, hosted by "Ladies
// Night"", "Harold Night ft. S.O.F.T."), so exact matching would silently
// break the moment a listing gains a subtitle. Two DIFFERENT group events
// sharing a prefix before a separator would merge - name them distinctly.
func seriesKey(title string) string {
	t := strings.ToLower(strings.TrimSpace(title))
	for _, sep := range []string{":", ",", "(", " ft.", " ft ", " feat", " hosted by", " with "} {
		if i := strings.Index(t, sep); i > 0 {
			t = t[:i]
		}
	}
	var b strings.Builder
	space := false
	for _, r := range t {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
		} else {
			space = true
		}
	}
	return b.String()
}

type venueSlot struct {
	at    time.Time
	venue string // location_address for this occurrence
}

// venueSeries is one recurring show from a feed, keyed by seriesKey. The
// series-level fields (title/type/description/cover) are only consulted when
// autoCreate materializes a brand-new series; an already-seeded series keeps
// its own content and just gains/moves/loses dates.
type venueSeries struct {
	title       string
	eventType   string
	description string
	coverURL    string // remote poster; fetched + stored once on create ("" = none)
	days        map[string]venueSlot
}

type venueSyncOpts struct {
	botID, botName, botHandle string
	autoCreate                bool
	loc                       *time.Location
}

type venueSyncStats struct {
	Adopted   int      `json:"adopted"`
	Created   int      `json:"created"`
	Retimed   int      `json:"retimed"`
	Cancelled int      `json:"cancelled"`
	Unmatched []string `json:"unmatched_titles,omitempty"`
}

func (s *server) syncVenueSeries(ctx context.Context, gid pgtype.UUID, series map[string]venueSeries, opts venueSyncOpts) (venueSyncStats, error) {
	var st venueSyncStats

	// The bot exists lazily; a handle collision with a real user is a hard
	// error we'd rather see than silently impersonate around.
	if _, err := s.queries.UpsertProfile(ctx, db.UpsertProfileParams{UserID: opts.botID, DisplayName: opts.botName, Handle: opts.botHandle}); err != nil {
		return st, err
	}

	events, err := s.queries.ListGroupEvents(ctx, gid)
	if err != nil {
		return st, err
	}
	byTitle := map[string][]db.Event{}
	for _, ev := range events {
		byTitle[seriesKey(ev.Title)] = append(byTitle[seriesKey(ev.Title)], ev)
	}

	// Group owner (fetched once) becomes cohost on auto-created series so the
	// person who runs the group keeps edit/cancel powers over bot-owned events.
	ownerID, ownerFetched := "", false
	groupOwner := func() string {
		if !ownerFetched {
			ownerFetched = true
			if g, gerr := s.queries.GetGroup(ctx, gid); gerr == nil {
				ownerID = g.OwnerID
			}
		}
		return ownerID
	}

	now := time.Now().In(opts.loc)
	today := now.Format("2006-01-02")

	for key, vs := range series {
		occs := byTitle[key]

		if len(occs) == 0 {
			if !opts.autoCreate {
				st.Unmatched = append(st.Unmatched, vs.title)
				continue
			}
			// AUTO-CREATE a brand-new series from the feed. Fetch the poster
			// ONCE (only new series pay this cost); every occurrence shares it.
			cover := ""
			if vs.coverURL != "" {
				cover = s.fetchPosterCover(ctx, vs.coverURL)
			}
			seriesID := newUUID()
			owner := groupOwner()
			for day, sl := range vs.days {
				if day < today {
					continue // don't materialize history
				}
				sib, cerr := s.queries.CreateEvent(ctx, db.CreateEventParams{
					HostID: opts.botID, Title: vs.title, EventType: vs.eventType, Description: vs.description,
					LocationMode: "host_place", LocationAddress: sl.venue,
					SchedulingMode: "fixed", StartsAt: pgtype.Timestamptz{Time: sl.at, Valid: true}, Status: "scheduled",
					GroupID: gid, SeriesID: seriesID, Recurrence: "custom",
					Visibility: "private", GeneralScope: "week", Timezone: opts.loc.String(),
				})
				if cerr != nil {
					return st, cerr
				}
				if cover != "" {
					_ = s.queries.SetEventLook(ctx, db.SetEventLookParams{ID: sib.ID, PhotoUrl: cover, Theme: ""})
				}
				if owner != "" {
					_ = s.queries.AddCohost(ctx, db.AddCohostParams{EventID: sib.ID, UserID: owner})
				}
				st.Created++
			}
			continue
		}

		// Adopt: bot becomes host everywhere, prior host keeps manage as cohost.
		for _, ev := range occs {
			if ev.HostID == opts.botID {
				continue
			}
			if err := s.queries.SetEventHost(ctx, db.SetEventHostParams{ID: ev.ID, HostID: opts.botID}); err != nil {
				return st, err
			}
			_ = s.queries.AddCohost(ctx, db.AddCohostParams{EventID: ev.ID, UserID: ev.HostID})
			st.Adopted++
		}

		// Series id (grow a lone matched event into a series if needed), the
		// template (latest occurrence = freshest content), and the existing
		// occurrence per calendar day.
		seriesID := pgtype.UUID{}
		template := occs[0]
		haveDay := map[string]db.Event{}
		minDay, maxDay := "9999-99-99", ""
		for d := range vs.days {
			if d < minDay {
				minDay = d
			}
			if d > maxDay {
				maxDay = d
			}
		}
		for _, ev := range occs {
			if ev.SeriesID.Valid {
				seriesID = ev.SeriesID
			}
			if ev.StartsAt.Valid {
				haveDay[ev.StartsAt.Time.In(opts.loc).Format("2006-01-02")] = ev
				if template.StartsAt.Valid && ev.StartsAt.Time.After(template.StartsAt.Time) {
					template = ev
				}
			}
		}
		if !seriesID.Valid {
			seriesID = newUUID()
			if err := s.queries.SetSeries(ctx, db.SetSeriesParams{ID: template.ID, SeriesID: seriesID, Recurrence: "custom"}); err != nil {
				return st, err
			}
		}
		for day, sl := range vs.days {
			if day < today {
				continue
			}
			if ev, exists := haveDay[day]; exists {
				if ev.Status == "scheduled" && ev.StartsAt.Valid && !ev.StartsAt.Time.Equal(sl.at) {
					if err := s.queries.RetimeEvent(ctx, db.RetimeEventParams{ID: ev.ID, StartsAt: pgtype.Timestamptz{Time: sl.at, Valid: true}}); err != nil {
						return st, err
					}
					st.Retimed++
				}
				continue
			}
			addr := template.LocationAddress
			if sl.venue != "" {
				addr = sl.venue
			}
			sib, cerr := s.queries.CreateEvent(ctx, db.CreateEventParams{
				HostID: opts.botID, Title: template.Title, EventType: template.EventType, Description: template.Description,
				LocationMode: template.LocationMode, LocationAddress: addr,
				SchedulingMode: "fixed", StartsAt: pgtype.Timestamptz{Time: sl.at, Valid: true}, Status: "scheduled",
				GroupID: template.GroupID, SeriesID: seriesID, Recurrence: "custom",
				Visibility: template.Visibility, Topic: template.Topic, City: template.City,
				CustomEmoji: template.CustomEmoji, CustomLabel: template.CustomLabel,
				GeneralScope: template.GeneralScope, Timezone: template.Timezone,
			})
			if cerr != nil {
				return st, cerr
			}
			if template.PhotoUrl != "" || template.Theme != "" {
				_ = s.queries.SetEventLook(ctx, db.SetEventLookParams{ID: sib.ID, PhotoUrl: template.PhotoUrl, Theme: template.Theme})
			}
			st.Created++
		}
		// Cancel: future scheduled occurrences the feed no longer lists, but
		// only inside the window the feed actually observed.
		for day, ev := range haveDay {
			if _, listed := vs.days[day]; listed || day <= today || day < minDay || day > maxDay {
				continue
			}
			if ev.Status != "scheduled" || ev.HostID != opts.botID {
				continue
			}
			if err := s.queries.CancelEventQuiet(ctx, ev.ID); err != nil {
				return st, err
			}
			st.Cancelled++
		}
	}
	return st, nil
}
