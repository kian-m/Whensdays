import { Link, useNavigate } from "react-router-dom";
import { Event, TYPE_COLORS, fmtDateTime, getJSON } from "../lib";
import { eventEmoji, eventLabel } from "../scheduler/questions";
import { Loading, Pill, useAsync } from "../ui";

type EventsResp = { hosting: Event[]; attending: Event[]; unseen: string[] };

const DAY = 86_400_000;

// Relative "how soon" label for upcoming events (Today / Tomorrow / in N days).
function soonLabel(iso: string): string {
  const d = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - startOfToday.getTime()) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export function Home() {
  const nav = useNavigate();
  const { data, loading } = useAsync<EventsResp>((api) => getJSON(api, "/api/events"));

  if (loading) return <Loading />;
  const hosting = data?.hosting ?? [];
  const attending = data?.attending ?? [];
  const unseen = new Set(data?.unseen ?? []);
  const empty = hosting.length === 0 && attending.length === 0;
  const open = (id: string) => nav(`/e/${id}`);

  // "Coming up": every event you're part of that's scheduled within the next
  // week, soonest first — the thing you actually want to see on landing.
  const now = Date.now();
  const seen = new Set<string>();
  const upcoming = [...hosting, ...attending]
    .filter((e) => {
      if (e.status !== "scheduled" || !e.starts_at || seen.has(e.id)) return false;
      const t = new Date(e.starts_at).getTime();
      if (t < now || t > now + 7 * DAY) return false;
      seen.add(e.id);
      return true;
    })
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());

  return (
    <div className="stack">
      <div className="row between">
        <h1>Your plans</h1>
        <span className="row">
          <Link to="/quick" className="btn soft" data-testid="quick-plan">⚡ Quick</Link>
          <Link to="/new" className="btn" data-testid="new-event">+ New event</Link>
        </span>
      </div>

      {empty && (
        <div className="card empty stack" data-testid="events-empty">
          <div style={{ fontSize: "2.4rem" }}>🗓️</div>
          <h3>No plans yet</h3>
          <p className="muted">Host a dinner, movie night or camping trip — or wait for an invite.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <Link to="/new" className="btn soft">Create your first event</Link>
            <Link to="/discover" className="btn ghost">Browse public events</Link>
          </div>
        </div>
      )}

      {upcoming.length > 0 && (
        <>
          <div className="section-h">Coming up</div>
          <div className="stack" data-testid="coming-up">
            {upcoming.map((e) => (
              <EventRow key={e.id} e={e} isNew={unseen.has(e.id)} soon={soonLabel(e.starts_at!)} onClick={() => open(e.id)} />
            ))}
          </div>
        </>
      )}

      {hosting.length > 0 && (
        <>
          <div className="section-h">Hosting</div>
          <div className="stack">
            {hosting.map((e) => <EventRow key={e.id} e={e} isNew={unseen.has(e.id)} onClick={() => open(e.id)} />)}
          </div>
        </>
      )}

      {attending.length > 0 && (
        <>
          <div className="section-h">Going & invited</div>
          <div className="stack">
            {attending.map((e) => <EventRow key={e.id} e={e} isNew={unseen.has(e.id)} onClick={() => open(e.id)} />)}
          </div>
        </>
      )}
    </div>
  );
}

function EventRow({ e, onClick, isNew, soon }: { e: Event; onClick: () => void; isNew?: boolean; soon?: string }) {
  const color = TYPE_COLORS[e.event_type] ?? TYPE_COLORS.other;
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
            : e.status === "cancelled" ? <Pill kind="declined">Cancelled</Pill>
            : <Pill kind="scheduled">Set</Pill>}
        </div>
        <div className="muted small">
          {eventLabel(e)} · {e.status === "polling" ? "Finding a time" : fmtDateTime(e.starts_at)}
        </div>
        <div className="muted small">
          {e.location_mode === "find_venue" ? "📍 Venue TBD" : `📍 ${e.location_address || "Host's place"}`}
        </div>
      </div>
    </div>
  );
}
