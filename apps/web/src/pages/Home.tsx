import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Event, TYPE_COLORS, fmtDateTime, getJSON } from "../lib";
import { eventEmoji, eventLabel } from "../scheduler/questions";
import { Avatar, Loading, Pill, useAsync } from "../ui";

// Avatar-stack preview: the API sends ≤6 prioritized faces (friends → people
// with photos → initials-only) + the total going count per event.
type Face = { name: string; avatar_url: string; is_friend: boolean };
type Pile = { faces: Face[]; going: number };
type EventsResp = { hosting: Event[]; attending: Event[]; unseen: string[]; faces?: Record<string, Pile> };
type Filter = "all" | "upcoming" | "hosting" | "attending";

const DAY = 86_400_000;

function soonLabel(iso: string): string {
  const d = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - startOfToday.getTime()) / DAY);
  if (days <= 0) return "Today";
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
  const { data, loading } = useAsync<EventsResp>((api) => getJSON(api, "/api/events"));
  const [filter, setFilter] = useState<Filter>("all");

  if (loading && !data) return <Loading />;
  const hosting = data?.hosting ?? [];
  const attending = data?.attending ?? [];
  const unseen = new Set(data?.unseen ?? []);
  const now = Date.now();

  // De-duped union for "all" / "upcoming".
  const byId = new Map<string, Event>();
  [...hosting, ...attending].forEach((e) => byId.set(e.id, e));
  const all = [...byId.values()];
  const upcoming = all.filter((e) => e.status === "scheduled" && e.starts_at && new Date(e.starts_at).getTime() >= now);

  const counts: Record<Filter, number> = {
    all: all.length, upcoming: upcoming.length, hosting: hosting.length, attending: attending.length,
  };
  const lists: Record<Filter, Event[]> = {
    all: [...all].sort(byWhen),
    upcoming: [...upcoming].sort(byWhen),
    hosting: [...hosting].sort(byWhen),
    attending: [...attending].sort(byWhen),
  };
  const shown = lists[filter];

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "upcoming", label: "Upcoming" },
    { key: "hosting", label: "Hosting" },
    { key: "attending", label: "Attending" },
  ];

  return (
    <div className="stack">
      <div className="row between">
        <h1>Your plans</h1>
        <span className="row">
          <Link to="/quick" className="btn soft" data-testid="quick-plan">⚡ Quick</Link>
          <Link to="/new" className="btn" data-testid="new-event">+ New event</Link>
        </span>
      </div>

      {/* Filter row — tap to narrow the list (Kalshi/Partiful-style). */}
      <div className="filter-row" data-testid="event-filters">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={`chip sm ${filter === f.key ? "on" : ""}`}
            data-testid={`filter-${f.key}`} onClick={() => setFilter(f.key)}>
            {f.label}{counts[f.key] > 0 && <span className="filter-count">{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      {all.length === 0 ? (
        <div className="card empty stack" data-testid="events-empty">
          <div style={{ fontSize: "2.4rem" }}>🗓️</div>
          <h3>No plans yet</h3>
          <p className="muted">Host a dinner, movie night or camping trip — or wait for an invite.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <Link to="/new" className="btn soft">Create your first event</Link>
            <Link to="/discover" className="btn ghost">Browse public events</Link>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <p className="muted small" data-testid="filter-empty">
          {filter === "upcoming" ? "Nothing scheduled yet — check your polls for times still being decided."
            : filter === "hosting" ? "You're not hosting anything right now."
            : "Nothing here — you haven't been added to any events."}
        </p>
      ) : (
        <div className="stack" data-testid="event-list">
          {shown.map((e) => (
            <EventRow key={e.id} e={e} pile={data?.faces?.[e.id]} isNew={unseen.has(e.id)}
              soon={e.starts_at ? soonLabel(e.starts_at) : ""} onClick={() => nav(`/e/${e.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ e, pile, onClick, isNew, soon }: {
  e: Event; pile?: Pile; onClick: () => void; isNew?: boolean; soon?: string;
}) {
  const color = TYPE_COLORS[e.event_type] ?? TYPE_COLORS.other;
  // Fit the row: show up to 5 faces, fold the rest into "+N more".
  const faces = (pile?.faces ?? []).slice(0, 5);
  const extra = (pile?.going ?? 0) - faces.length;
  return (
    <div className="card ev tile" data-testid="event-row" onClick={onClick} style={{ borderLeftColor: color }}>
      <div className="emoji" style={{ background: `${color}22` }}>{eventEmoji(e)}</div>
      <div style={{ flex: 1 }}>
        <div className="row between">
          <span className="title row" style={{ gap: 6 }}>
            {e.title}
            {isNew && <span className="dot-badge" data-testid="event-new" title="You haven't opened this yet">NEW</span>}
          </span>
          {soon ? <Pill kind="scheduled">{soon}</Pill>
            : e.status === "polling" ? <Pill kind="polling">Polling</Pill>
            : <Pill kind="scheduled">Set</Pill>}
        </div>
        <div className="muted small">
          {eventLabel(e)} · {e.status === "polling" ? "Finding a time" : fmtDateTime(e.starts_at)}
        </div>
        <div className="muted small">
          {e.location_mode === "find_venue" ? "📍 Venue TBD" : `📍 ${e.location_address || "Host's place"}`}
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
