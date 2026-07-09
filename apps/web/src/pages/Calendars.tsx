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

type CalendarResp = { connections: CalendarConnection[]; events: ImportedEvent[]; outlook_enabled: boolean };

const PROVIDER_LABEL: Record<CalendarProvider, string> = {
  google: "Google Calendar",
  apple_caldav: "Apple Calendar",
  outlook: "Outlook",
  apple_ical: "Published link (any calendar)",
};

function FeedCard() {
  const { data } = useAsync<{ url: string; webcal: string }>((a) => getJSON(a, "/api/calendar/feed-url"));
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  return (
    <div className="card stack" data-testid="feed-card">
      <div>
        <h3>Your Whensdays feed</h3>
        <p className="muted small">Subscribe once - every event you're going to appears in your calendar automatically and stays up to date.</p>
      </div>
      <div className="row">
        <a className="btn sm" data-testid="feed-subscribe" href={data.webcal}>Subscribe (Apple / Outlook)</a>
        <button className="btn ghost sm" data-testid="feed-copy"
          onClick={() => { navigator.clipboard?.writeText(data.url); setCopied(true); }}>
          {copied ? "Copied" : "Copy URL for Google"}
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Google Calendar: Other calendars → + → From URL → paste. Treat the URL like a password - anyone with it sees your events.</p>
    </div>
  );
}

// One connections row. The label side shrinks (long provider names / account
// emails must never push the buttons off screen); buttons stay intrinsic.
function ProviderRow({ icon, label, connectedLabel, connectTestid, disconnectTestid, onConnect, onDisconnect, children }: {
  icon: string; label: string; connectedLabel?: string;
  connectTestid: string; disconnectTestid: string;
  onConnect: () => void; onDisconnect: () => void; children?: React.ReactNode;
}) {
  const connected = connectedLabel !== undefined;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <span className="row" style={{ gap: 8, flex: "1 1 auto", minWidth: 0 }}>
          <span style={{ flex: "none" }}>{icon}</span>
          <span style={{ minWidth: 0 }}>{label}</span>
        </span>
        {connected ? (
          <span className="row" style={{ gap: 10, flex: "0 1 auto", minWidth: 0, justifyContent: "flex-end" }}>
            <span className="muted small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{connectedLabel}</span>
            <button className="btn ghost sm" style={{ flex: "none" }} data-testid={disconnectTestid} onClick={onDisconnect}>Disconnect</button>
          </span>
        ) : (
          <button className="btn sm" style={{ flex: "none" }} data-testid={connectTestid} onClick={onConnect}>Connect</button>
        )}
      </div>
      {children}
    </div>
  );
}

export function CalendarConnections() {
  const api = useApi();
  const { data, loading, reload } = useAsync<CalendarResp>((a) => getJSON(a, "/api/calendar/events"));
  const [msg, setMsg] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState<"" | "caldav" | "ical">("");
  const [appleId, setAppleId] = useState("");
  const [appPw, setAppPw] = useState("");
  const [icalUrl, setIcalUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function oauthConnect(provider: "google" | "outlook") {
    analytics.capture(EVENTS.calendarConnectStarted, { provider });
    const res = await api(`/api/calendar/${provider}/connect`);
    if (!res.ok) return setMsg(`${PROVIDER_LABEL[provider]} isn't available right now.`);
    const { auth_url } = await res.json();
    window.location.href = auth_url;
  }
  async function connectCalDAV(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const res = await sendJSON(api, "POST", "/api/calendar/apple-caldav", { apple_id: appleId.trim(), app_password: appPw });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setErr(b.error || "could not connect");
    }
    setAppleId(""); setAppPw(""); setOpenForm("");
    analytics.capture(EVENTS.calendarConnectStarted, { provider: "apple_caldav" });
    reload();
  }
  async function connectICal(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const res = await sendJSON(api, "POST", "/api/calendar/apple", { ical_url: icalUrl });
    if (!res.ok) return setErr("That doesn't look like a valid calendar URL.");
    setIcalUrl(""); setOpenForm("");
    reload();
  }
  async function disconnect(provider: CalendarProvider) {
    await api(`/api/calendar/connections/${provider}`, { method: "DELETE" });
    reload();
  }

  if (loading && !data) return null;
  const connections = data?.connections ?? [];
  const labelOf = (p: CalendarProvider) => connections.find((c) => c.provider === p)?.account_label;

  return (
    <div className="card stack" data-testid="calendar-connections">
      <div>
        <h3>Connected calendars</h3>
        <p className="muted small">Read-only and private: your busy times grey out availability and flag conflicts. Nothing is shared or published.</p>
      </div>
      <ProviderRow icon="📅" label={PROVIDER_LABEL.google} connectedLabel={labelOf("google")}
        connectTestid="connect-google" disconnectTestid="disconnect-google"
        onConnect={() => oauthConnect("google")} onDisconnect={() => disconnect("google")} />
      <ProviderRow icon="🍎" label={PROVIDER_LABEL.apple_caldav} connectedLabel={labelOf("apple_caldav")}
        connectTestid="connect-apple-caldav-open" disconnectTestid="disconnect-apple-caldav"
        onConnect={() => { setErr(null); setOpenForm(openForm === "caldav" ? "" : "caldav"); }}
        onDisconnect={() => disconnect("apple_caldav")}>
        {openForm === "caldav" && (
          <form className="stack" style={{ gap: 8 }} onSubmit={connectCalDAV}>
            <p className="muted small" style={{ margin: 0 }}>
              Private - no publishing. Generate an <strong>app-specific password</strong> at{" "}
              <a href="https://account.apple.com/account/manage" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>account.apple.com</a>{" "}
              (Sign-In &amp; Security → App-Specific Passwords). We store it encrypted and only ever read.
            </p>
            <input className="input" data-testid="apple-caldav-id" value={appleId} autoComplete="username"
              placeholder="Apple ID (email)" onChange={(e) => setAppleId(e.target.value)} />
            <input className="input" type="password" data-testid="apple-caldav-password" value={appPw} autoComplete="off"
              placeholder="App-specific password (xxxx-xxxx-xxxx-xxxx)" onChange={(e) => setAppPw(e.target.value)} />
            <div className="row">
              <button className="btn sm" data-testid="connect-apple-caldav" disabled={busy}>{busy ? "Checking…" : "Connect"}</button>
            </div>
            {err && <p className="muted small" style={{ color: "var(--no)" }}>{err}</p>}
          </form>
        )}
      </ProviderRow>
      {data?.outlook_enabled && (
        <ProviderRow icon="📆" label={PROVIDER_LABEL.outlook} connectedLabel={labelOf("outlook")}
          connectTestid="connect-outlook" disconnectTestid="disconnect-outlook"
          onConnect={() => oauthConnect("outlook")} onDisconnect={() => disconnect("outlook")} />
      )}
      <ProviderRow icon="🔗" label={PROVIDER_LABEL.apple_ical} connectedLabel={labelOf("apple_ical")}
        connectTestid="connect-apple-open" disconnectTestid="disconnect-apple"
        onConnect={() => { setErr(null); setOpenForm(openForm === "ical" ? "" : "ical"); }}
        onDisconnect={() => disconnect("apple_ical")}>
        {openForm === "ical" && (
          <form className="stack" style={{ gap: 8 }} onSubmit={connectICal}>
            <p className="muted small" style={{ margin: 0 }}>
              Fallback for any calendar that can publish a link. iCloud: share a calendar as <strong>Public</strong> (the URL is unguessable but anyone holding it can read that calendar). Outlook: Settings → Shared calendars → Publish.
            </p>
            <div className="row">
              <input className="input" data-testid="apple-url" value={icalUrl} onChange={(e) => setIcalUrl(e.target.value)}
                placeholder="webcal://p01.icloud.com/published/…" />
              <button className="btn sm" data-testid="connect-apple" style={{ flex: "none" }}>Add</button>
            </div>
            {err && <p className="muted small" style={{ color: "var(--no)" }}>{err}</p>}
          </form>
        )}
      </ProviderRow>
      {msg && <p className="muted small" data-testid="calendar-msg">{msg}</p>}
      <FeedCard />
    </div>
  );
}
