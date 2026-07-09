import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarConnection,
  CalendarProvider,
  Event,
  ImportedEvent,
  TYPE_COLORS,
  getJSON,
  sendJSON,
  useApi,
} from "../lib";
import { Loading, useAsync } from "../ui";
import { EVENTS, analytics } from "../analytics";

// ---------------------------------------------------------------------------
// The Calendars page: an Outlook/Apple-style calendar of YOUR schedule - your
// scheduler events (hosting + attending) merged with imported calendar events -
// with month / week / day views and prev/today/next navigation. Connection
// management lives on the Profile page (CalendarConnections below).
// ---------------------------------------------------------------------------

type CalItem = {
  key: string;
  title: string;
  start: Date;
  color: string; // type color for scheduler events, gray for imported
  eventId?: string; // navigable for scheduler events
  imported?: boolean;
};

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);
const startOfWeek = (d: Date) => addDays(d, -d.getDay()); // Sunday
const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function Calendars() {
  const nav = useNavigate();
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [cursor, setCursor] = useState(() => new Date());
  const today = new Date();

  const { data: mine, loading } = useAsync<{ hosting: Event[]; attending: Event[] }>((a) => getJSON(a, "/api/events"));
  const { data: imported } = useAsync<{ events: ImportedEvent[] }>((a) => getJSON(a, "/api/calendar/events"));

  // Merge everything into per-day buckets.
  const byDay = useMemo(() => {
    const m = new Map<string, CalItem[]>();
    const push = (it: CalItem) => {
      const k = dayKey(it.start);
      m.set(k, [...(m.get(k) ?? []), it]);
    };
    for (const e of [...(mine?.hosting ?? []), ...(mine?.attending ?? [])]) {
      if (!e.starts_at || e.status === "cancelled") continue;
      push({
        key: `s-${e.id}`, title: e.title, start: new Date(e.starts_at),
        color: TYPE_COLORS[e.event_type] ?? TYPE_COLORS.other, eventId: e.id,
      });
    }
    for (const [i, e] of (imported?.events ?? []).entries()) {
      push({ key: `i-${i}`, title: e.title, start: new Date(e.starts_at), color: "#8a879a", imported: true });
    }
    for (const items of m.values()) items.sort((a, b) => a.start.getTime() - b.start.getTime());
    return m;
  }, [mine, imported]);

  function move(dir: -1 | 1) {
    if (view === "month") setCursor((c) => new Date(c.getFullYear(), c.getMonth() + dir, 1));
    else setCursor((c) => addDays(c, dir * (view === "week" ? 7 : 1)));
  }

  const title =
    view === "month"
      ? cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : view === "week"
        ? `${startOfWeek(cursor).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${addDays(startOfWeek(cursor), 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
        : cursor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  if (loading && !mine) return <Loading />;

  return (
    <div className="stack">
      <div className="row between wrap">
        <h1 data-testid="cal-title">{title}</h1>
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn ghost sm" data-testid="cal-prev" onClick={() => move(-1)}>←</button>
          <button type="button" className="btn ghost sm" data-testid="cal-today" onClick={() => setCursor(new Date())}>Today</button>
          <button type="button" className="btn ghost sm" data-testid="cal-next" onClick={() => move(1)}>→</button>
        </div>
      </div>
      <div className="row" style={{ gap: 4 }}>
        {(["day", "week", "month"] as const).map((v) => (
          <button key={v} type="button" className={`chip sm ${view === v ? "on" : ""}`}
            data-testid={`cal-view-${v}`} onClick={() => setView(v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>

      {view === "month" && <MonthGrid cursor={cursor} today={today} byDay={byDay}
        onOpen={(id) => nav(`/e/${id}`)} onPickDay={(d) => { setCursor(d); setView("day"); }} />}
      {view === "week" && <WeekGrid cursor={cursor} today={today} byDay={byDay} onOpen={(id) => nav(`/e/${id}`)} />}
      {view === "day" && <DayList cursor={cursor} byDay={byDay} onOpen={(id) => nav(`/e/${id}`)} />}

      <p className="muted small">Colored entries are your Whensdays; gray ones come from connected calendars (manage them on your <a href="/profile" style={{ textDecoration: "underline" }}>Profile</a>).</p>
    </div>
  );
}

const WEEKDAY_HEADS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function MonthGrid({ cursor, today, byDay, onOpen, onPickDay }: {
  cursor: Date; today: Date; byDay: Map<string, CalItem[]>;
  onOpen: (id: string) => void; onPickDay: (d: Date) => void;
}) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d)));
  return (
    <div className="cal-month" data-testid="cal-month">
      {WEEKDAY_HEADS.map((h) => <div key={h} className="cal-head">{h}</div>)}
      {weeks.flat().map((d) => {
        const items = byDay.get(dayKey(d)) ?? [];
        const other = d.getMonth() !== cursor.getMonth();
        return (
          <div key={dayKey(d)} className={`cal-cell ${other ? "cal-other" : ""}`} onClick={() => onPickDay(d)}>
            <span className={`cal-daynum ${sameDay(d, today) ? "cal-today" : ""}`}>{d.getDate()}</span>
            {items.slice(0, 3).map((it) => (
              <button key={it.key} type="button" className="cal-pill" title={it.title}
                style={{ background: `${it.color}22`, color: it.color }}
                onClick={(ev) => { ev.stopPropagation(); if (it.eventId) onOpen(it.eventId); }}>
                {it.title}
              </button>
            ))}
            {items.length > 3 && <span className="muted" style={{ fontSize: "0.68rem" }}>+{items.length - 3} more</span>}
          </div>
        );
      })}
    </div>
  );
}

function WeekGrid({ cursor, today, byDay, onOpen }: {
  cursor: Date; today: Date; byDay: Map<string, CalItem[]>; onOpen: (id: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));
  return (
    <div className="cal-week" data-testid="cal-week">
      {days.map((d) => (
        <div key={dayKey(d)} className="cal-week-col">
          <div className={`cal-week-head ${sameDay(d, today) ? "cal-week-today" : ""}`}>
            <span className="muted small">{WEEKDAY_HEADS[d.getDay()]}</span>
            <strong>{d.getDate()}</strong>
          </div>
          <div className="stack" style={{ gap: 4, padding: "4px 4px 8px" }}>
            {(byDay.get(dayKey(d)) ?? []).map((it) => (
              <button key={it.key} type="button" className="cal-pill cal-pill-lg" title={it.title}
                style={{ background: `${it.color}22`, color: it.color, borderLeft: `3px solid ${it.color}` }}
                onClick={() => it.eventId && onOpen(it.eventId)}>
                <span className="cal-pill-time">{fmtTime(it.start)}</span>
                {it.title}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DayList({ cursor, byDay, onOpen }: {
  cursor: Date; byDay: Map<string, CalItem[]>; onOpen: (id: string) => void;
}) {
  const items = byDay.get(dayKey(cursor)) ?? [];
  return (
    <div className="card stack" data-testid="cal-day">
      {items.length === 0 && <p className="muted small" data-testid="cal-day-empty">Nothing scheduled this day.</p>}
      {items.map((it) => (
        <button key={it.key} type="button" className="row cal-day-row" onClick={() => it.eventId && onOpen(it.eventId)}
          style={{ cursor: it.eventId ? "pointer" : "default" }}>
          <span className="muted small" style={{ width: 76, textAlign: "right" }}>{fmtTime(it.start)}</span>
          <span style={{ width: 4, alignSelf: "stretch", borderRadius: 2, background: it.color }} />
          <span className="stack" style={{ gap: 0, alignItems: "flex-start" }}>
            <strong>{it.title}</strong>
            {it.imported && <span className="muted small">from a connected calendar</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection management - rendered on the PROFILE page.
// ---------------------------------------------------------------------------

type CalendarResp = { connections: CalendarConnection[]; events: ImportedEvent[] };

const PROVIDER_LABEL: Record<CalendarProvider, string> = {
  google: "Google Calendar",
  apple_ical: "Apple Calendar",
};

export function CalendarConnections() {
  const api = useApi();
  const { data, loading, reload } = useAsync<CalendarResp>((a) => getJSON(a, "/api/calendar/events"));
  const [msg, setMsg] = useState<string | null>(null);

  async function connectGoogle() {
    analytics.capture(EVENTS.calendarConnectStarted, { provider: "google" });
    const res = await api("/api/calendar/google/connect");
    if (!res.ok) return setMsg("Google Calendar isn't available right now.");
    const { auth_url } = await res.json();
    window.location.href = auth_url;
  }
  async function disconnect(provider: CalendarProvider) {
    await api(`/api/calendar/connections/${provider}`, { method: "DELETE" });
    reload();
  }

  if (loading && !data) return null;
  const connections = data?.connections ?? [];
  const has = (p: CalendarProvider) => connections.some((c) => c.provider === p);

  return (
    <div className="card stack" data-testid="calendar-connections">
      <div>
        <h3>Connected calendars</h3>
        <p className="muted small">Read-only: your busy times grey out availability and flag conflicts. See everything on the Calendars tab.</p>
      </div>
      <div className="row between">
        <span className="row" style={{ gap: 8 }}>📅 {PROVIDER_LABEL.google}</span>
        {has("google") ? (
          // flex:0 1 auto overrides the mobile .row.between > .row flex:none
          // rule so a long account email ellipsizes instead of pushing the
          // Disconnect button off screen.
          <span className="row" style={{ gap: 10, flex: "0 1 auto", minWidth: 0, justifyContent: "flex-end" }}>
            <span className="muted small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {connections.find((c) => c.provider === "google")?.account_label}
            </span>
            <button className="btn ghost sm" style={{ flex: "none" }} data-testid="disconnect-google" onClick={() => disconnect("google")}>Disconnect</button>
          </span>
        ) : (
          <button className="btn sm" data-testid="connect-google" onClick={connectGoogle}>Connect</button>
        )}
      </div>
      <AppleRow connected={has("apple_ical")} label={connections.find((c) => c.provider === "apple_ical")?.account_label}
        onConnected={reload} onDisconnect={() => disconnect("apple_ical")} />
      {msg && <p className="muted small" data-testid="calendar-msg">{msg}</p>}
    </div>
  );
}

function AppleRow({ connected, label, onConnected, onDisconnect }: {
  connected: boolean;
  label?: string;
  onConnected: () => void;
  onDisconnect: () => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const res = await sendJSON(api, "POST", "/api/calendar/apple", { ical_url: url });
    if (!res.ok) return setErr("That doesn't look like a valid calendar URL.");
    setUrl("");
    setOpen(false);
    onConnected();
  }

  if (connected) {
    return (
      <div className="row between">
        <span className="row" style={{ gap: 8 }}>🍎 {PROVIDER_LABEL.apple_ical}</span>
        {/* same shrink+ellipsis treatment as the Google row */}
        <span className="row" style={{ gap: 10, flex: "0 1 auto", minWidth: 0, justifyContent: "flex-end" }}>
          <span className="muted small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
          <button className="btn ghost sm" style={{ flex: "none" }} data-testid="disconnect-apple" onClick={onDisconnect}>Disconnect</button>
        </span>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <span className="row" style={{ gap: 8 }}>🍎 {PROVIDER_LABEL.apple_ical}</span>
        <button className="btn sm" data-testid="connect-apple-open" onClick={() => setOpen((o) => !o)}>Connect</button>
      </div>
      {open && (
        <form className="stack" style={{ gap: 8 }} onSubmit={submit}>
          <p className="muted small" style={{ margin: 0 }}>
            In iCloud Calendar, share a calendar as <strong>Public</strong> and paste its link (starts with <code>webcal://</code>).
          </p>
          <div className="row">
            <input className="input" data-testid="apple-url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="webcal://p01.icloud.com/published/…" />
            <button className="btn sm" data-testid="connect-apple">Add</button>
          </div>
          {err && <p className="muted small" style={{ color: "var(--no)" }}>{err}</p>}
        </form>
      )}
    </div>
  );
}
