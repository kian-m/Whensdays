import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Event, Group, PublicEvent, collapseSeries, eventIsPast, fetchDashboard, getJSON, seriesCounts, fmtDateTime, useApi, useProfile } from "../lib";
import { Avatar, EventThumb, ListSkeleton, Pill, useAsync } from "../ui";
import { Ic } from "../Icons";

// Avatar-stack preview: the API sends ≤6 prioritized faces (friends → people
// with photos → initials-only) + the total going count per event.
type Face = { name: string; avatar_url: string; is_friend: boolean };
type Pile = { faces: Face[]; going: number };
type EventsResp = {
  hosting: Event[]; attending: Event[]; unseen: string[];
  faces?: Record<string, Pile>; my_rsvps?: Record<string, string>;
  // Cheap count so the web only bothers fetching the followed-events feed
  // (a second round trip) when it can possibly have something to show.
  follow_count?: number;
};
type Filter = "all" | "upcoming" | "hosting" | "attending" | "past" | "drafts" | "declined" | "following";

const DAY = 86_400_000;

function soonLabel(iso: string): string {
  const d = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - startOfToday.getTime()) / DAY);
  if (days < 0) return ""; // already happened - no urgency pill
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return `In ${days} days`;
  return "";
}

// Sort: scheduled events soonest-first, then time-less polls (newest first).
function byWhen(a: Event, b: Event): number {
  const at = a.starts_at ? new Date(a.starts_at).getTime() : Infinity;
  const bt = b.starts_at ? new Date(b.starts_at).getTime() : Infinity;
  if (at !== bt) return at - bt;
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

export function Home() {
  const nav = useNavigate();
  const api = useApi();
  const profile = useProfile();
  const { data, loading } = useAsync<EventsResp>(fetchDashboard);
  const [filter, setFilter] = useState<Filter>("all");

  // "From pages you follow": only worth a fetch once the dashboard tells us
  // there's ≥1 follow to show (follow_count gates it - see VENUE-PAGES.md V2).
  const followCount = data?.follow_count ?? 0;
  const [followingEvents, setFollowingEvents] = useState<PublicEvent[]>([]);
  useEffect(() => {
    if (followCount === 0) { setFollowingEvents([]); return; }
    let cancelled = false;
    api("/api/feed?scope=following").then(async (res) => {
      if (!res.ok || cancelled) return;
      const b = await res.json();
      if (!cancelled) setFollowingEvents(b.events ?? []);
    });
    return () => { cancelled = true; };
  }, [api, followCount]);

  // No full-page loader: the chrome below renders instantly and the list area
  // shows skeleton tiles until the first fetch lands (revisits hit the cache).
  const firstLoad = loading && !data;
  const hosting = data?.hosting ?? [];
  const attending = data?.attending ?? [];
  const unseen = new Set(data?.unseen ?? []);
  const now = Date.now();
  // Past events leave every active view and live only under "Past".
  const isPast = eventIsPast;
  // Past tiles say what happened for YOU: hosted it or RSVP'd going = Attended.
  const hostingIds = new Set(hosting.map((e) => e.id));
  const attended = (e: Event) => hostingIds.has(e.id) || data?.my_rsvps?.[e.id] === "going";

  // De-duped union for "all" / "upcoming" / "past".
  const byId = new Map<string, Event>();
  [...hosting, ...attending].forEach((e) => byId.set(e.id, e));
  const union = [...byId.values()];

  // Brand-new page owner nudge (V5 onboarding): only worth a fetch once we
  // already know the user has zero events at all - cheap enough not to bother
  // otherwise. "Owns exactly one group" is the operational stand-in for "just
  // made their page" (purpose isn't stored server-side - see VENUE-PAGES.md).
  const [ownedGroups, setOwnedGroups] = useState<Group[] | null>(null);
  useEffect(() => {
    if (firstLoad || union.length !== 0) { return; }
    let cancelled = false;
    getJSON<{ groups: Group[] }>(api, "/api/groups")
      .then((b) => { if (!cancelled) setOwnedGroups(b.groups); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, firstLoad, union.length === 0]);
  const onlyOwnedGroup = (() => {
    if (!ownedGroups || !profile) return null;
    const owned = ownedGroups.filter((g) => g.owner_id === profile.user_id);
    return owned.length === 1 ? owned[0] : null;
  })();
  // Drafts live ONLY under their own filter - parked, not deleted. Same for
  // events you said Can't-go to: out of the active views, in their own bucket.
  const drafts = union.filter((e) => e.status === "draft");
  const iDeclined = (e: Event) => data?.my_rsvps?.[e.id] === "declined" && !hostingIds.has(e.id);
  const live = union.filter((e) => e.status !== "draft");
  const past = live.filter(isPast);
  const declined = live.filter((e) => !isPast(e) && iDeclined(e));
  const all = live.filter((e) => !isPast(e) && !iDeclined(e));
  const upcoming = all.filter((e) => e.status === "scheduled" && e.starts_at && new Date(e.starts_at).getTime() >= now);

  const activeHosting = hosting.filter((e) => e.status !== "draft" && !isPast(e));
  // Attending = the attending array PLUS cohosted events you RSVP'd going or
  // maybe to. Cohosted rows ride in `hosting` (the dashboard unions them), so
  // without this an RSVP on an event you help run never surfaces here - e.g.
  // every UCB series occurrence after the sync bot adopted it (you = cohost).
  const attendingIds = new Set(attending.map((e) => e.id));
  const cohostAttending = hosting.filter((e) => {
    const r = data?.my_rsvps?.[e.id];
    return e.host_id !== profile?.user_id && !attendingIds.has(e.id) && (r === "going" || r === "maybe");
  });
  const activeAttending = [...attending, ...cohostAttending].filter((e) => e.status !== "draft" && !isPast(e) && !iDeclined(e));
  // A recurring series shows as ONE tile: its next upcoming occurrence in the
  // active views, its most-recent one under Past (collapse then re-sort).
  const newestFirst = (a: Event, b: Event) => new Date(b.starts_at!).getTime() - new Date(a.starts_at!).getTime();
  // "following" isn't an Event[] list (it's PublicEvent[] from the feed
  // endpoint, a different shape) - keep it out of this record and handle it
  // as its own branch below.
  type ListFilter = Exclude<Filter, "following">;
  const lists: Record<ListFilter, Event[]> = {
    all: collapseSeries(all).sort(byWhen),
    upcoming: collapseSeries(upcoming).sort(byWhen),
    hosting: collapseSeries(activeHosting).sort(byWhen),
    attending: collapseSeries(activeAttending).sort(byWhen),
    // Past reads newest-first - the most recent memory on top.
    past: collapseSeries(past, "latest").sort(newestFirst),
    drafts: collapseSeries(drafts).sort(byWhen),
    declined: collapseSeries(declined).sort(byWhen),
  };
  const counts: Record<ListFilter, number> = {
    all: lists.all.length, upcoming: lists.upcoming.length,
    hosting: lists.hosting.length, attending: lists.attending.length,
    past: lists.past.length, drafts: lists.drafts.length, declined: lists.declined.length,
  };
  const shown = filter === "following" ? [] : lists[filter];
  const chipCount = (k: Filter) => (k === "following" ? followingEvents.length : counts[k]);
  // "🔁 N dates" counts only the occurrences relevant to the view: remaining
  // dates on active tiles (the number goes DOWN as dates pass), past ones
  // under Past. Union-wide counts would keep showing the series' full length.
  const scountActive = seriesCounts(live.filter((e) => !isPast(e)));
  const scountPast = seriesCounts(past);

  // Followed-feed preview under the user's own tiles: next 3, deduped against
  // whatever's already in their own hosting/attending list by event id (a
  // group you're also invited to shouldn't show twice).
  const dashboardIds = new Set(union.map((e) => e.id));
  const dedupedFollowing = followingEvents.filter((e) => !dashboardIds.has(e.id));
  const followingPreview = dedupedFollowing.slice(0, 3);

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "upcoming", label: "Upcoming" },
    { key: "hosting", label: "Hosting" },
    { key: "attending", label: "Attending" },
    { key: "past", label: "Past" },
    // These only earn a chip once there's something to show - zero clutter
    // otherwise (Following mirrors how the Drafts chip behaves).
    ...(followCount > 0 ? [{ key: "following" as Filter, label: "Following" }] : []),
    ...(drafts.length > 0 ? [{ key: "drafts" as Filter, label: "Drafts" }] : []),
    ...(declined.length > 0 ? [{ key: "declined" as Filter, label: "Can't go" }] : []),
  ];

  return (
    <div className="stack">
      <div className="row between">
        <h1>Your plans</h1>
        <Link to="/new" className="btn primary" data-testid="new-event">+ New event</Link>
      </div>

      {/* Filter row - tap to narrow the list (Kalshi/Partiful-style). */}
      <div className="filter-row" data-testid="event-filters">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={`chip sm ${filter === f.key ? "on" : ""}`}
            data-testid={`filter-${f.key}`} onClick={() => setFilter(f.key)}>
            {f.label}{chipCount(f.key) > 0 && <span className="filter-count">{chipCount(f.key)}</span>}
          </button>
        ))}
      </div>

      {firstLoad ? (
        <ListSkeleton rows={4} />
      ) : filter === "following" ? (
        followingEvents.length === 0 ? (
          <p className="muted small" data-testid="filter-empty">
            Nothing new from the pages you follow yet.
          </p>
        ) : (
          <div className="stack" data-testid="event-list">
            {followingEvents.map((e) => (
              <FollowedTile key={e.id} e={e} onClick={() => nav(`/e/${e.id}`)} />
            ))}
          </div>
        )
      ) : (
        <>
          {union.length === 0 ? (
            <div className="card empty stack" data-testid="events-empty">
              <h3>No plans yet</h3>
              <p className="muted">Host a dinner, movie night or camping trip - or wait for an invite.</p>
              {/* No Discover link here - the public surface is out of the product
                  until group density exists (see the TABS comment in App.tsx). */}
              <div className="row wrap" style={{ justifyContent: "center" }}>
                <Link to="/new" className="btn soft">Create your first event</Link>
              </div>
              {/* Only for someone who owns exactly one group and has zero
                  events - a first-time page owner who hasn't posted yet. */}
              {onlyOwnedGroup && (
                <>
                  <p className="muted small" style={{ margin: 0 }} data-testid="page-owner-hint">
                    {onlyOwnedGroup.name} is ready for its first event.
                  </p>
                  <div className="row wrap" style={{ justifyContent: "center" }}>
                    <Link to={`/new?group=${onlyOwnedGroup.id}`} className="btn ghost" data-testid="page-first-event">
                      Post your first event
                    </Link>
                  </div>
                </>
              )}
            </div>
          ) : shown.length === 0 ? (
            <p className="muted small" data-testid="filter-empty">
              {filter === "upcoming" ? "Nothing scheduled yet - check your polls for times still being decided."
                : filter === "hosting" ? "You're not hosting anything right now."
                : filter === "past" ? "No past events yet - memories land here the day after."
                : filter === "all" ? "Nothing coming up - everything's in Past."
                : filter === "drafts" ? "No drafts."
                : filter === "declined" ? "Nothing you've declined."
                : "Nothing here - you haven't been added to any events."}
            </p>
          ) : (
            <div className="stack" data-testid="event-list">
              {shown.map((e) => (
                <EventRow key={e.id} e={e} pile={data?.faces?.[e.id]} isNew={unseen.has(e.id)}
                  past={isPast(e)} attended={attended(e)} declinedByMe={iDeclined(e)}
                  seriesN={e.series_id ? ((isPast(e) ? scountPast : scountActive)[e.series_id] ?? 1) : 0}
                  soon={!isPast(e) && e.starts_at ? soonLabel(e.starts_at) : ""} onClick={() => nav(`/e/${e.id}`)} />
              ))}
            </div>
          )}

          {/* "From pages you follow" - visible on the default view even when
              the user has no own plans, not only behind the Following chip. */}
          {filter === "all" && followingPreview.length > 0 && (
            <div className="stack" data-testid="following-section">
              <div className="row between">
                <div className="section-h" style={{ margin: 0 }}>From pages you follow</div>
                <button type="button" className="btn ghost sm" data-testid="following-see-all"
                  onClick={() => setFilter("following")}>See all</button>
              </div>
              <div className="stack">
                {followingPreview.map((e) => (
                  <FollowedTile key={e.id} e={e} onClick={() => nav(`/e/${e.id}`)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A followed-page event: the standard tile plus a small attribution line -
// links to the page when it belongs to a group, plain text otherwise. Lighter
// than EventRow since the feed row carries no location/RSVP/series data (see
// ListPublicEventsRow). Precedence group > performer > host (VENUE-PAGES.md
// V7): a group attributes "via {group}", a confirmed-followed performer
// attributes "with {performer}" (a different preposition on purpose - you're
// seeing this because of a PERSON, not a page), otherwise "via {host}".
function FollowedTile({ e, onClick }: { e: PublicEvent; onClick: () => void }) {
  const viaGroup = e.group_id && e.group_name;
  const page = viaGroup ? e.group_name : e.performer_name || e.host_name;
  const prefix = !viaGroup && e.performer_name ? "with" : "via";
  return (
    <div className={`card ev tile ${e.theme ? `theme-tile theme-${e.theme}` : ""}`}
      data-testid="following-tile" onClick={onClick}>
      <EventThumb photo={e.photo_url} title={e.title} size={72} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span className="title">{e.title}</span>
        <div className="muted small"><span className="stamp time">{fmtDateTime(e.starts_at)}</span></div>
        {/* "muted small line, standard link styling" - the "via"/"with" wrapper
            stays muted, but the page name itself is a real link (default `a`
            color + hover underline) when it's a group, not just gray text. */}
        {page && (
          <div className="muted small" data-testid="following-attribution">
            {prefix} {e.group_id && viaGroup ? (
              <Link to={`/g/${e.group_id}`} onClick={(ev) => ev.stopPropagation()}>{page}</Link>
            ) : page}
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ e, pile, onClick, isNew, soon, past, attended, declinedByMe, seriesN }: {
  e: Event; pile?: Pile; onClick: () => void; isNew?: boolean; soon?: string;
  past?: boolean; attended?: boolean; declinedByMe?: boolean; seriesN?: number;
}) {
  // Fit the row: show up to 5 faces, fold the rest into "+N more".
  const faces = (pile?.faces ?? []).slice(0, 5);
  const extra = (pile?.going ?? 0) - faces.length;
  return (
    <div className={`card ev tile ${e.theme ? `theme-tile theme-${e.theme}` : ""}`} data-testid="event-row" onClick={onClick}>
      <EventThumb photo={e.photo_url} title={e.title} size={72} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row between">
          {/* Long titles wrap onto new lines instead of pushing the status pill
              off the tile: NOT className="row" (the mobile .row.between > .row
              rule would pin it at intrinsic width), and the pill is flex:none. */}
          <span className="title" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            {e.title}
            {isNew && <span className="dot-badge" data-testid="event-new" title="You haven't opened this yet">NEW</span>}
          </span>
          <span style={{ flex: "none" }}>
            {e.status === "draft" ? <Pill kind="">Draft</Pill>
              : declinedByMe && !past ? <Pill kind="declined">Can't go</Pill>
              : past ? (attended ? <Pill kind="scheduled">Attended</Pill> : <Pill kind="">Passed</Pill>)
              : soon ? <Pill kind="deciding">{soon}</Pill>
              : e.status === "polling" ? <Pill kind="polling">Polling</Pill>
              : <Pill kind="scheduled">Set</Pill>}
          </span>
        </div>
        <div className="muted small">
          {e.status === "polling" ? "Finding a time" : <span className="stamp time">{fmtDateTime(e.starts_at)}</span>}
          {seriesN && seriesN > 1 ? <span className="stamp" data-testid="series-badge"> · SERIES · {seriesN} DATES</span> : null}
        </div>
        <div className="muted small" style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
          {e.location_mode === "virtual" ? (
            <><span style={{ display: "flex" }}>{Ic.link(14)}</span>Online</>
          ) : e.location_mode === "find_venue" ? (
            <><span style={{ display: "flex" }}>{Ic.place(14)}</span>Location TBD</>
          ) : (
            <><span style={{ display: "flex" }}>{Ic.place(14)}</span>{e.location_address || "Host's place"}</>
          )}
        </div>
        {faces.length > 0 && (
          <div className="facepile" data-testid="facepile">
            {faces.map((f, i) => (
              <span key={i} className={`face ${f.is_friend ? "face-friend" : ""}`} title={f.name}>
                <Avatar url={f.avatar_url || null} name={f.name} size={22} />
              </span>
            ))}
            <span className="muted small" style={{ marginLeft: 6 }}>
              {extra > 0 ? `+${extra} more going` : "going"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
