import { Link, useNavigate } from "react-router-dom";
import { Event, fmtDateTime, getJSON } from "../lib";
import { emojiFor, labelFor } from "../scheduler/questions";
import { Loading, Pill, useAsync } from "../ui";

type EventsResp = { hosting: Event[]; attending: Event[] };

export function Home() {
  const nav = useNavigate();
  const { data, loading } = useAsync<EventsResp>((api) => getJSON(api, "/api/events"));

  if (loading) return <Loading />;
  const hosting = data?.hosting ?? [];
  const attending = data?.attending ?? [];
  const empty = hosting.length === 0 && attending.length === 0;

  return (
    <div className="stack">
      <div className="row between">
        <h1>Your plans</h1>
        <Link to="/new" className="btn" data-testid="new-event">+ New event</Link>
      </div>

      {empty && (
        <div className="card empty stack" data-testid="events-empty">
          <div style={{ fontSize: "2.4rem" }}>🗓️</div>
          <h3>No plans yet</h3>
          <p className="muted">Host a dinner, movie night or camping trip — or wait for an invite.</p>
          <div><Link to="/new" className="btn soft">Create your first event</Link></div>
        </div>
      )}

      {hosting.length > 0 && (
        <>
          <div className="section-h">Hosting</div>
          <div className="stack">
            {hosting.map((e) => <EventRow key={e.id} e={e} onClick={() => nav(`/e/${e.id}`)} />)}
          </div>
        </>
      )}

      {attending.length > 0 && (
        <>
          <div className="section-h">Going & invited</div>
          <div className="stack">
            {attending.map((e) => <EventRow key={e.id} e={e} onClick={() => nav(`/e/${e.id}`)} />)}
          </div>
        </>
      )}
    </div>
  );
}

function EventRow({ e, onClick }: { e: Event; onClick: () => void }) {
  return (
    <div className="card ev" data-testid="event-row" onClick={onClick}>
      <div className="emoji">{emojiFor(e.event_type)}</div>
      <div style={{ flex: 1 }}>
        <div className="row between">
          <span className="title">{e.title}</span>
          {e.status === "polling"
            ? <Pill kind="polling">Polling</Pill>
            : <Pill kind="scheduled">Set</Pill>}
        </div>
        <div className="muted small">
          {labelFor(e.event_type)} · {e.status === "polling" ? "Finding a time" : fmtDateTime(e.starts_at)}
        </div>
        <div className="muted small">
          {e.location_mode === "find_venue" ? "📍 Venue TBD" : `📍 ${e.location_address || "Host's place"}`}
        </div>
      </div>
    </div>
  );
}
