import { Fragment, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Attendee,
  CATEGORIES,
  CITY_OPTIONS,
  DAYPARTS,
  EventDetail,
  Friend,
  GeneralVote,
  PrefAnswer,
  ImportedEvent,
  TimeOption,
  Vote,
  WEEKDAYS,
  EVENT_THEMES,
  busyConflict,
  daysFromDate,
  fmtDate,
  fmtDateTime,
  toDatetimeLocal,
  getJSON,
  guessCity,
  importedBusy,
  mapsUrl,
  appleMapsUrl,
  nextMonths,
  sendJSON,
  useApi,
} from "../lib";
import { QUESTIONS, eventEmoji, eventLabel, questionLabel } from "../scheduler/questions";
import { AddressInput, Avatar, BackLink, ConfirmButton, DayGrid, GifPicker, Loading, Pill, fileToAvatar, useAsync } from "../ui";
import { EVENTS, analytics } from "../analytics";


export function EventPage() {
  const { id } = useParams();
  const { data, loading, reload } = useAsync<EventDetail>((api) => getJSON(api, `/api/events/${id}`), [id]);
  const [preview, setPreview] = useState(false);
  // Live theme preview while editing the hero card — reflects the whole page
  // before the edit is saved. null = show the saved theme.
  const [themePreview, setThemePreview] = useState<string | null>(null);
  // The lock moment: when this session watches the status flip polling →
  // scheduled, celebrate — a one-shot confetti burst + banner. Catching the
  // transition here (rather than in each finalize button) covers every path.
  const prevStatus = useRef<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!data) return;
    const prev = prevStatus.current;
    prevStatus.current = data.event.status;
    if (prev === "polling" && data.event.status === "scheduled") {
      setCelebrate(true);
      const t = setTimeout(() => setCelebrate(false), 3400);
      return () => clearTimeout(t);
    }
  }, [data]);

  if (loading && !data) return <Loading />;
  if (!data) return <div className="stack"><BackLink /><p className="muted">Event not found.</p></div>;

  const showManage = data.can_manage && !preview;
  const e = data.event;
  const effTheme = themePreview ?? e.theme;

  return (
    <div className={`stack ${effTheme ? `event-theme theme-${effTheme}` : ""}`}>
      {celebrate && <div className="fx-locked" data-testid="locked-banner">It&rsquo;s locked in 🎉</div>}
      <BackLink />
      <HeroCard data={data} reload={reload} canEdit={showManage && e.status !== "cancelled"} onPreviewTheme={setThemePreview} />

      {e.status === "cancelled" && (
        <div className="card empty" data-testid="cancelled-note">
          <p className="muted">This get-together was cancelled by the host.</p>
        </div>
      )}

      {data.series && data.series.length > 1 && <SeriesCard data={data} />}

      {e.status === "scheduled" && e.starts_at && <AddToCalendar event={e} />}
      {e.status === "scheduled" && e.starts_at && <IntentLinks event={e} attendees={data.attendees} />}

      {e.status !== "cancelled" && (showManage ? <HostView data={data} reload={reload} /> : <GuestView data={data} reload={reload} />)}

      {e.status !== "cancelled" && <InviteFriends data={data} reload={reload} />}

      <EventComments data={data} reload={reload} />

      {!preview && e.status !== "cancelled" && <MuteToggle data={data} />}

      {data.role === "host" && (
        <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} data-testid="preview-toggle"
          onClick={() => setPreview((p) => { analytics.capture(EVENTS.previewToggled, { to: !p ? "guest" : "host" }); return !p; })}>
          {preview ? "← Back to host view" : "👀 Preview as guest"}
        </button>
      )}
    </div>
  );
}

// Per-event notification mute — available to anyone on the event (host or
// attendee). Hosts use it to stop the RSVP/comment stream; attendees to stop
// finalize/reminder mail. Also toggleable one-click from any email.
function MuteToggle({ data }: { data: EventDetail }) {
  const api = useApi();
  const [muted, setMuted] = useState(data.muted);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    const next = !muted;
    const res = await sendJSON(api, "POST", `/api/events/${data.event.id}/mute`, { muted: next });
    setBusy(false);
    if (res.ok) {
      setMuted(next);
      analytics.capture(EVENTS.notificationsMuted, { muted: next });
    }
  }
  return (
    <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} data-testid="mute-toggle"
      disabled={busy} onClick={toggle}
      title={muted ? "You won't get emails about this event" : "Stop emails about this event"}>
      {muted ? "🔕 Notifications muted — turn back on" : "🔔 Mute notifications"}
    </button>
  );
}

// ---------------- recurring series ----------------

// Representative start hour per daypart — used when the host schedules straight
// from a heat cell (they can fine-tune afterwards; the time stays editable).
const DAYPART_HOUR: Record<string, number> = {
  early_morning: 8, morning: 10, noon: 12, afternoon: 15, evening: 19, night: 21,
};

const RECURRENCE_LABEL: Record<string, string> = {
  weekly: "weekly", biweekly: "every 2 weeks", monthly: "monthly", custom: "on picked dates",
};

// Sibling occurrences of a recurring event; the one being viewed is highlighted.
// When the series is running dry (last occurrence within ~3 weeks or already
// past), the host gets a one-tap "poll for next dates" that re-invites everyone.
function SeriesCard({ data }: { data: EventDetail }) {
  const nav = useNavigate();
  const series = data.series!;
  const idx = series.findIndex((s) => s.id === data.event.id);
  const last = series[series.length - 1];
  const endingSoon = last?.starts_at
    ? new Date(last.starts_at).getTime() < Date.now() + 21 * 24 * 3600_000
    : false;
  return (
    <div className="card stack" data-testid="series">
      <h3 style={{ margin: 0 }}>
        🔁 Repeats {RECURRENCE_LABEL[data.event.recurrence] || ""} · {idx + 1} of {series.length}
      </h3>
      <div className="row wrap" style={{ gap: 6 }}>
        {series.map((s, i) => (
          <button key={s.id} type="button"
            className={`chip sm ${s.id === data.event.id ? "on" : ""}`}
            data-testid={`series-occ-${i}`}
            onClick={() => s.id !== data.event.id && nav(`/e/${s.id}`)}>
            {fmtDate(s.starts_at)}
          </button>
        ))}
      </div>
      {data.can_manage && endingSoon && (
        <button type="button" className="btn soft sm" style={{ alignSelf: "flex-start" }}
          data-testid="series-repoll"
          onClick={() => nav(`/new?again=${last.id}&repoll=1`)}>
          📅 Poll the group for the next dates
        </button>
      )}
    </div>
  );
}

// ---------------- invite friends ----------------

// Anyone on the event can invite THEIR friends (friendship = the permission,
// enforced server-side). Already-attending/invited friends are filtered out.
function InviteFriends({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const { data: fr } = useAsync<{ friends: { id: string; friend_id: string; display_name: string; handle: string; avatar_url: string }[] }>(
    (a) => getJSON(a, "/api/friends"),
  );
  const there = new Set([
    ...data.attendees.map((a) => a.user_id),
    ...data.invites.map((i) => i.user_id),
    ...data.cohosts.map((c) => c.user_id),
    data.event.host_id,
  ]);
  const invitable = (fr?.friends ?? []).filter((f) => !there.has(f.friend_id));
  const invitedNames = data.invites.filter((i) => i.display_name).map((i) => i.display_name);
  if (invitable.length === 0 && invitedNames.length === 0) return null;

  async function invite(friendId: string) {
    await sendJSON(api, "POST", `/api/events/${data.event.id}/invites`, { friend_id: friendId });
    reload();
  }

  return (
    <div className="card stack" data-testid="invite-friends">
      <h3 style={{ margin: 0 }}>Invite friends</h3>
      {invitable.map((f) => (
        <div key={f.friend_id} className="row between">
          <span className="row" style={{ gap: 8 }}>
            <Avatar url={f.avatar_url} name={f.display_name} size={28} />
            <span>{f.display_name} <span className="muted small">@{f.handle}</span></span>
          </span>
          <button className="btn soft sm" data-testid={`invite-${f.handle}`} onClick={() => invite(f.friend_id)}>Invite</button>
        </div>
      ))}
      {invitedNames.length > 0 && (
        <p className="muted small">Invited: {invitedNames.join(", ")}</p>
      )}
    </div>
  );
}

// ---------------- add to calendar (export) ----------------

// Compact iCal/Google UTC stamp, e.g. 20260715T190000Z.
function gcalStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Builds an "Add to Google Calendar" template URL entirely client-side — no API
// call or account needed. Matches the API's 2h default export duration.
function googleCalendarUrl(e: EventDetail["event"]): string {
  const start = new Date(e.starts_at!);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const location = e.location_mode === "find_venue" ? "Venue to be decided" : e.location_address || "Address to come";
  const link = `${window.location.origin}/e/${e.id}`;
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${gcalStamp(start)}/${gcalStamp(end)}`,
    details: `${e.description ? e.description + "\n\n" : ""}RSVP & details: ${link}`,
    location,
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

function AddToCalendar({ event }: { event: EventDetail["event"] }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);

  async function downloadICS() {
    setBusy(true);
    try {
      const res = await api(`/api/events/${event.id}/calendar.ics`);
      if (!res.ok) throw new Error(`ics ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${event.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event"}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      analytics.capture(EVENTS.addToCalendarClicked, { target: "ics" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="add-to-calendar">
      <h3 style={{ margin: 0 }}>Add to your calendar</h3>
      <p className="muted small" style={{ margin: 0 }}>One tap — title, time and a link back to this page ride along.</p>
      <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
        {/* Plain link (no fetch): iPhone/Mac open the .ics straight in Calendar. */}
        <a className="btn sm" data-testid="add-apple" href={`/api/events/${event.id}/calendar.ics`}
          onClick={() => analytics.capture(EVENTS.addToCalendarClicked, { target: "apple" })}>
           Apple Calendar
        </a>
        <a
          className="btn ghost sm"
          data-testid="add-google"
          href={googleCalendarUrl(event)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => analytics.capture(EVENTS.addToCalendarClicked, { target: "google" })}
        >
          📅 Google Calendar
        </a>
        <button className="btn ghost sm" data-testid="download-ics" disabled={busy} onClick={downloadICS}>
          ⬇️ .ics file
        </button>
      </div>
    </div>
  );
}

// ---------------- intent links (book a table, find a place) ----------------

function IntentLinks({ event, attendees }: { event: EventDetail["event"]; attendees: Attendee[] }) {
  const going = Math.max(2, attendees.filter((a) => a.rsvp === "going").length);
  const type = event.event_type;

  if (type === "dinner" || type === "drinks") {
    const href = `https://www.opentable.com/s?dateTime=${encodeURIComponent(event.starts_at!)}&covers=${going}`;
    return (
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Make it happen</h3>
        <div>
          <a
            className="btn ghost sm"
            data-testid="intent-dinner"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => analytics.capture(EVENTS.intentLinkClicked, { target: "opentable", event_type: type })}
          >
            🍽️ Book a table
          </a>
        </div>
      </div>
    );
  }

  if (type === "trip" || type === "camping") {
    const date = event.starts_at!.slice(0, 10);
    const href = `https://www.booking.com/searchresults.html?checkin=${date}`;
    return (
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Make it happen</h3>
        <div>
          <a
            className="btn ghost sm"
            data-testid="intent-stay"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => analytics.capture(EVENTS.intentLinkClicked, { target: "booking", event_type: type })}
          >
            🏡 Find a place to stay
          </a>
        </div>
      </div>
    );
  }

  return null;
}

// ---------------- guest / invitee experience ----------------

function GuestView({ data, reload }: { data: EventDetail; reload: () => void }) {
  const e = data.event;
  const myRsvp = data.attendees.find((a) => a.user_id === data.viewer_id)?.rsvp;
  const myAnswers = data.preference_answers.filter((a) => a.user_id === data.viewer_id);
  return (
    <div className="stack">
      <WhosIn data={data} />
      <Rsvp eventId={e.id} current={myRsvp} reload={reload} />
      {e.scheduling_mode === "poll" && e.status === "polling" && (
        <PollVote eventId={e.id} options={data.time_options} votes={data.votes} viewerId={data.viewer_id} reload={reload} />
      )}
      {e.scheduling_mode === "general" && e.status === "polling" && (
        <GeneralPoll event={e} votes={data.general_votes} viewerId={data.viewer_id} reload={reload} />
      )}
      {/* Preferences sit OFF the critical path (roadmap): collapsed unless the
          guest already answered. Skipped entirely for types with no questions. */}
      {(QUESTIONS[e.event_type] ?? []).length > 0 && (
        <details data-testid="pref-details" open={myAnswers.length > 0}>
          <summary className="muted small" style={{ cursor: "pointer" }} data-testid="pref-summary">
            ✍️ Anything the host should know? (optional)
          </summary>
          <PrefFlow eventId={e.id} type={e.event_type} answers={myAnswers} reload={reload} />
        </details>
      )}
      <Guests attendees={data.attendees} viewerId={data.viewer_id} />
    </div>
  );
}

// WhosIn — live social pressure above the fold on the invite page: a progress
// bar of committed vs invited plus the going facepile.
function WhosIn({ data }: { data: EventDetail }) {
  const going = data.attendees.filter((a) => a.rsvp === "going");
  const responded = new Set(data.attendees.map((a) => a.user_id));
  const pending = data.invites.filter((i) => !responded.has(i.user_id)).length;
  const total = data.attendees.length + pending;
  if (total < 2) return null; // nothing social to show yet
  return (
    <div className="card stack" style={{ gap: 8 }} data-testid="whos-in">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Who&rsquo;s in</h3>
        <span className="muted small" data-testid="whos-in-count"><b>{going.length}</b> of {total} in</span>
      </div>
      <div className="whosin-bar"><span style={{ width: `${Math.round((going.length / total) * 100)}%` }} /></div>
      {going.length > 0 && (
        <div className="facepile">
          {going.slice(0, 6).map((a) => (
            <span className="face" key={a.user_id}><Avatar url={a.avatar_url ?? ""} name={a.display_name ?? "?"} size={28} /></span>
          ))}
          {going.length > 6 && <span className="muted small" style={{ marginLeft: 8 }}>+{going.length - 6} more</span>}
        </div>
      )}
    </div>
  );
}

function Rsvp({ eventId, current, reload }: { eventId: string; current?: string; reload: () => void }) {
  const api = useApi();
  // OPTIMISTIC: the tap flips the selection instantly — waiting on the POST
  // plus a full event refetch before showing the choice felt broken (Cloud Run
  // + Neon round-trips add up). Server sync + reload happen in the background;
  // a failed POST reverts the flip.
  const [sel, setSel] = useState<string | undefined>(undefined);
  const active = sel ?? current;
  function set(rsvp: string) {
    const prev = active;
    setSel(rsvp);
    sendJSON(api, "POST", `/api/events/${eventId}/rsvp`, { rsvp })
      .then((res) => { if (!res.ok) setSel(prev); else reload(); })
      .catch(() => setSel(prev));
  }
  const opts: [string, string][] = [["going", "✅ Going"], ["maybe", "🤔 Maybe"], ["declined", "✕ Can't"]];
  return (
    <div className="card stack">
      <h3>Are you in?</h3>
      <div className="row wrap">
        {opts.map(([v, label]) => (
          <button key={v} className={`chip ${active === v ? "on" : ""}`} data-testid={`rsvp-${v}`} onClick={() => set(v)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PollVote({ eventId, options, votes, viewerId, reload }: {
  eventId: string; options: TimeOption[]; votes: Vote[]; viewerId: string; reload: () => void;
}) {
  const api = useApi();
  const initial: Record<string, string> = {};
  votes.filter((v) => v.user_id === viewerId).forEach((v) => (initial[v.option_id] = v.response));
  const [picks, setPicks] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState(false);
  // Your imported calendar (if connected) flags options you're already busy for.
  const { data: cal } = useAsync<{ events: ImportedEvent[] }>((a) => getJSON(a, "/api/calendar/events"));
  const intervals = importedBusy(cal?.events ?? []).intervals;

  async function save() {
    const payload = Object.entries(picks).map(([option_id, response]) => ({ option_id, response }));
    await sendJSON(api, "POST", `/api/events/${eventId}/votes`, { votes: payload });
    setSaved(true);
    reload();
  }

  return (
    <div className="card stack">
      <h3>Which times work?</h3>
      {options.map((o, i) => (
        <div key={o.id} className="row between">
          <span className="small">
            {fmtDateTime(o.starts_at)}
            {busyConflict(intervals, o.starts_at) && (
              <span className="pill maybe" style={{ marginLeft: 6 }} data-testid={`busy-${i}`}
                title={`Conflicts with: ${busyConflict(intervals, o.starts_at)}`}>⚠️ busy</span>
            )}
          </span>
          <div className="row">
            {(["yes", "maybe", "no"] as const).map((r) => (
              <button key={r} className={`chip sm ${picks[o.id] === r ? "on" : ""}`}
                data-testid={`vote-${i}-${r}`}
                onClick={() => { setPicks((p) => ({ ...p, [o.id]: r })); setSaved(false); }}>
                {r === "yes" ? "👍" : r === "maybe" ? "🤷" : "👎"}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button className="btn soft sm" style={{ alignSelf: "flex-start" }} data-testid="save-votes" onClick={save}>
        {saved ? "Saved ✓" : "Save availability"}
      </button>
    </div>
  );
}

// General-availability poll: the guest picks ideal months, plus a per-day grid of
// times of day (tap a cell, a day header for the whole column, or a time label for
// the whole row). The whole set is saved at once (replace semantics on the API).
const slotKey = (wd: number, dp: string) => `${wd}:${dp}`;

// The attendee's side of a general poll. The event's scope decides the question:
//   week    → "which days & times work this week?"  (7 concrete dates × dayparts)
//   month   → "which days work this month?"          (28 concrete date chips)
//   general → "when do things usually work?"         (months + weekday × daypart)
// The date windows are anchored at the event's created_at so every attendee
// answers about the same days.
function GeneralPoll({ event, votes, viewerId, reload }: {
  event: EventDetail["event"]; votes: GeneralVote[]; viewerId: string; reload: () => void;
}) {
  const api = useApi();
  const scope = event.general_scope;
  const months = nextMonths(6);
  const mine = votes.filter((v) => v.user_id === viewerId);

  const [selMonths, setSelMonths] = useState<Set<string>>(
    new Set(mine.filter((v) => v.dimension === "month").map((v) => v.value)),
  );
  const [cells, setCells] = useState<Set<string>>(
    new Set(mine.filter((v) => v.dimension === "slot").map((v) => v.value)),
  );
  const [dayCells, setDayCells] = useState<Set<string>>(
    new Set(mine.filter((v) => v.dimension === "dayslot").map((v) => v.value)),
  );
  const [saved, setSaved] = useState(false);

  const mutate = <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, fn: (s: Set<T>) => void) => {
    setSaved(false);
    setter((prev) => {
      const next = new Set(prev);
      fn(next);
      return next;
    });
  };
  const toggleMonth = (m: string) => mutate(setSelMonths, (s) => (s.has(m) ? s.delete(m) : s.add(m)));
  const toggleCell = (k: string) => mutate(setCells, (s) => (s.has(k) ? s.delete(k) : s.add(k)));
  // Toggle a whole column (a day) or row (a daypart): fill unless already full.
  const toggleColumn = (wd: number) => mutate(setCells, (s) => {
    const keys = DAYPARTS.map((dp) => slotKey(wd, dp.value));
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });
  const toggleRow = (dp: string) => mutate(setCells, (s) => {
    const keys = WEEKDAYS.map((_, wd) => slotKey(wd, dp));
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });

  // Week scope: 7 concrete dates × dayparts (same DayGrid as availability).
  const weekDates = daysFromDate(event.created_at, 7);
  const toggleDayCell = (day: string, dp: string) => mutate(setDayCells, (s) => (s.has(`${day}:${dp}`) ? s.delete(`${day}:${dp}`) : s.add(`${day}:${dp}`)));
  const toggleDayRow = (day: string) => mutate(setDayCells, (s) => {
    const keys = DAYPARTS.map((dp) => `${day}:${dp.value}`);
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });
  const toggleDayCol = (dp: string) => mutate(setDayCells, (s) => {
    const keys = weekDates.map((d) => `${d.value}:${dp}`);
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });

  // Month scope: 28 concrete dates × dayparts — same grid as week, longer window.
  const monthDates = daysFromDate(event.created_at, 28);
  const toggleMonthCol = (dp: string) => mutate(setDayCells, (s) => {
    const keys = monthDates.map((d) => `${d.value}:${dp}`);
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });

  async function save() {
    const body: Record<string, unknown> = {};
    if (scope === "week") {
      body.day_slots = [...dayCells].map((k) => {
        const [day, dp] = k.split(":");
        return { day, daypart: dp };
      });
    } else if (scope === "month") {
      body.day_slots = [...dayCells].map((k) => {
        const [day, dp] = k.split(":");
        return { day, daypart: dp };
      });
    } else {
      body.months = [...selMonths];
      body.slots = [...cells].map((k) => {
        const [wd, dp] = k.split(":");
        return { weekday: Number(wd), daypart: dp };
      });
    }
    await sendJSON(api, "POST", `/api/events/${event.id}/general-votes`, body);
    setSaved(true);
    reload();
  }

  return (
    <div className="card stack">
      <h3>
        {scope === "week" ? "When are you free this week?"
          : scope === "month" ? "Which days work this month?"
          : "When works for you?"}
      </h3>

      {scope === "week" && (
        <div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="muted small">Tap the times that work (a date or column header fills the line)</span>
            <button type="button" className="btn ghost sm" data-testid="gpw-clear"
              disabled={dayCells.size === 0} onClick={() => mutate(setDayCells, (s) => s.clear())}>Clear</button>
          </div>
          <DayGrid dates={weekDates} free={dayCells} idPrefix="gpw" testid="gp-week-grid"
            onToggle={toggleDayCell} onToggleRow={toggleDayRow} onToggleCol={toggleDayCol} />
        </div>
      )}

      {scope === "month" && (
        <div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="muted small">Tap the times that work over the next 4 weeks (a date or column header fills the line)</span>
            <button type="button" className="btn ghost sm" data-testid="gp-days-clear"
              disabled={dayCells.size === 0} onClick={() => mutate(setDayCells, (s) => s.clear())}>Clear</button>
          </div>
          <DayGrid dates={monthDates} free={dayCells} idPrefix="gpm" testid="gp-month-grid"
            onToggle={toggleDayCell} onToggleRow={toggleDayRow} onToggleCol={toggleMonthCol} />
        </div>
      )}

      {scope === "general" && (
        <>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>Ideal months</div>
            <div className="row wrap">
              {months.map((m, i) => (
                <button key={m.value} className={`chip sm ${selMonths.has(m.value) ? "on" : ""}`}
                  data-testid={`gp-month-${i}`} onClick={() => toggleMonth(m.value)}>{m.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>Times that work (tap a day or row label to fill it)</div>
            <div className="grid" style={{ gridTemplateColumns: "auto repeat(7, 1fr)" }}>
              <div />
              {WEEKDAYS.map((d, wd) => (
                <button key={wd} type="button" className="hd gp-head" data-testid={`gp-col-${wd}`}
                  onClick={() => toggleColumn(wd)}>{d}</button>
              ))}
              {DAYPARTS.map((dp) => (
                <Fragment key={dp.value}>
                  <button type="button" className="day gp-head" style={{ textAlign: "left" }}
                    data-testid={`gp-row-${dp.value}`} onClick={() => toggleRow(dp.value)}>{dp.label}</button>
                  {WEEKDAYS.map((_, wd) => {
                    const k = slotKey(wd, dp.value);
                    return <button key={wd} type="button" data-testid={`gp-cell-${wd}-${dp.value}`}
                      className={`cell ${cells.has(k) ? "on" : ""}`} onClick={() => toggleCell(k)} />;
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </>
      )}

      <button className="btn soft sm" style={{ alignSelf: "flex-start" }} data-testid="save-general" onClick={save}>
        {saved ? "Saved ✓" : "Save availability"}
      </button>
    </div>
  );
}

// Airtable-style: ask preference questions one at a time, keyed to event type.
function PrefFlow({ eventId, type, answers, reload }: {
  eventId: string; type: EventDetail["event"]["event_type"]; answers: PrefAnswer[]; reload: () => void;
}) {
  const api = useApi();
  const questions = QUESTIONS[type] ?? [];
  const existing: Record<string, string> = {};
  answers.forEach((a) => (existing[a.question_key] = a.answer));

  const [draft, setDraft] = useState<Record<string, string>>(existing);
  const [step, setStep] = useState(0);
  const done = answers.length >= questions.length && questions.length > 0;
  const [editing, setEditing] = useState(!done);

  if (questions.length === 0) return null;

  async function saveAll() {
    const payload = Object.entries(draft)
      .filter(([, v]) => v.trim() !== "")
      .map(([question_key, answer]) => ({ question_key, answer }));
    await sendJSON(api, "POST", `/api/events/${eventId}/preferences`, { answers: payload });
    setEditing(false);
    reload();
  }

  if (!editing) {
    return (
      <div className="card stack">
        <div className="row between"><h3>Your preferences</h3>
          <button className="btn ghost sm" data-testid="pref-edit" onClick={() => { setEditing(true); setStep(0); }}>Edit</button>
        </div>
        {questions.map((q) => (
          <div key={q.key} className="small">
            <span className="muted">{q.prompt}</span><br />
            <strong>{existing[q.key] || "—"}</strong>
          </div>
        ))}
      </div>
    );
  }

  const q = questions[step];
  const last = step === questions.length - 1;
  return (
    <div className="card stack">
      <div className="row between">
        <h3>A couple quick questions</h3>
        <span className="muted small">{step + 1}/{questions.length}</span>
      </div>
      <div>
        <label className="field" htmlFor="pf">{q.prompt}</label>
        <input id="pf" className="input" data-testid="pref-input" placeholder={q.placeholder}
          value={draft[q.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [q.key]: e.target.value }))} />
      </div>
      <div className="row">
        {step > 0 && <button className="btn ghost sm" data-testid="pref-back" onClick={() => setStep((s) => s - 1)}>Back</button>}
        {last
          ? <button className="btn sm" data-testid="pref-save" onClick={saveAll}>Save</button>
          : <button className="btn sm" data-testid="pref-next" onClick={() => setStep((s) => s + 1)}>Next</button>}
      </div>
    </div>
  );
}

// ---------------- host management view ----------------

function HostView({ data, reload }: { data: EventDetail; reload: () => void }) {
  const e = data.event;
  return (
    <div className="stack">
      <ShareLink eventId={e.id} />
      <Nudge data={data} />
      {e.scheduling_mode === "poll" && e.status === "polling" && (
        <PollResults data={data} reload={reload} />
      )}
      {e.scheduling_mode === "general" && e.status === "polling" && (
        <GeneralResults data={data} reload={reload} />
      )}
      <Guests attendees={data.attendees} viewerId={data.viewer_id} />
      <AnswerSummary data={data} />
      {data.role === "host" && <HostControls data={data} reload={reload} />}
    </div>
  );
}

// Nudge — the host's lever for "nobody replied": one tap re-emails only the
// invited people who haven't responded (server rate-limits to once a day).
function Nudge({ data }: { data: EventDetail }) {
  const api = useApi();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const responded = new Set(data.attendees.map((a) => a.user_id));
  const pending = data.invites.filter((i) => !responded.has(i.user_id)).length;
  if (pending === 0 || data.event.status === "cancelled") return null;
  async function nudge() {
    setBusy(true);
    const res = await sendJSON(api, "POST", `/api/events/${data.event.id}/nudge`, {});
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? `Nudged ${b.nudged} ${b.nudged === 1 ? "person" : "people"} 📣` : b.error || "could not nudge");
  }
  return (
    <div className="row wrap" style={{ gap: 10 }}>
      <button className="btn soft sm" data-testid="nudge" disabled={busy} onClick={nudge}>
        🔔 Nudge {pending} who haven&rsquo;t replied
      </button>
      {msg && <span className="muted small" data-testid="nudge-msg">{msg}</span>}
    </div>
  );
}

// The hero card: cover art + title/meta, and — for the host/cohosts — an Edit
// button that flips the card into in-place editing (details, visibility, a
// square cover photo or Klipy GIF, and a page backdrop theme).
function HeroCard({ data, reload, canEdit, onPreviewTheme }: { data: EventDetail; reload: () => void; canEdit: boolean; onPreviewTheme: (t: string | null) => void }) {
  const api = useApi();
  const e = data.event;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(e.title);
  const [desc, setDesc] = useState(e.description);
  const [locMode, setLocMode] = useState(e.location_mode);
  const [locAddr, setLocAddr] = useState(e.location_address);
  const [visibility, setVisibility] = useState(e.visibility);
  const [topic, setTopic] = useState(e.topic);
  const [city, setCity] = useState(e.city || guessCity());
  const [photo, setPhoto] = useState(e.photo_url);
  const [theme, setTheme] = useState(e.theme);
  // Editable start time — only meaningful once the event has a concrete time
  // (fixed or finalized); a poll still decides its time by voting.
  const [startsAt, setStartsAt] = useState(e.starts_at && e.status === "scheduled" ? toDatetimeLocal(e.starts_at) : "");
  const [endsAt, setEndsAt] = useState(e.ends_at ? toDatetimeLocal(e.ends_at) : "");
  // Sibling occurrences (multi-date series): every date is editable from here,
  // one input per occurrence. Keyed by sibling event id.
  const sibs = (data.series ?? []).filter((x) => x.id !== e.id && x.starts_at);
  const [sibTimes, setSibTimes] = useState<Record<string, string>>({});
  const sibValue = (id: string, iso: string) => sibTimes[id] ?? toDatetimeLocal(iso);
  // Series editing: apply content edits (title/details/cover/theme…) to every
  // occurrence — each keeps its own date.
  const [applySeries, setApplySeries] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function openEdit() {
    // Re-seed from the freshest event so a stale card never overwrites edits.
    setTitle(e.title); setDesc(e.description); setLocMode(e.location_mode);
    setLocAddr(e.location_address); setVisibility(e.visibility);
    setTopic(e.topic); setCity(e.city || guessCity());
    setPhoto(e.photo_url); setTheme(e.theme); setMsg(null);
    setStartsAt(e.starts_at && e.status === "scheduled" ? toDatetimeLocal(e.starts_at) : "");
    setEndsAt(e.ends_at ? toDatetimeLocal(e.ends_at) : "");
    setSibTimes({});
    setEditing(true);
  }

  async function onPickPhoto(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      setPhoto(await fileToAvatar(file, 420)); // square cover, client-resized
    } catch {
      setMsg("could not read image");
    }
  }

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setMsg(null);
    const res = await sendJSON(api, "PUT", `/api/events/${e.id}`, {
      title, description: desc, location_mode: locMode, location_address: locAddr,
      visibility, topic: visibility === "public" ? topic : "", city: visibility === "public" ? city.trim() : "",
      photo_url: photo, theme,
      starts_at: startsAt ? new Date(startsAt).toISOString() : "",
      ends_at: endsAt ? new Date(endsAt).toISOString() : "",
      apply_series: applySeries,
      series_times: sibs
        .filter((x) => sibTimes[x.id] && sibTimes[x.id] !== toDatetimeLocal(x.starts_at!))
        .map((x) => ({ id: x.id, starts_at: new Date(sibTimes[x.id]).toISOString() })),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setMsg(b.error || "could not save");
    }
    setEditing(false);
    onPreviewTheme(null);
    reload();
  }

  if (!editing) {
    return (
      <div className="card stack">
        {e.photo_url && <img className="event-cover" data-testid="event-cover" src={e.photo_url} alt="" />}
        <div className="row" style={{ gap: "0.9rem" }}>
          <div className="emoji" style={{ fontSize: "1.8rem", width: 56, height: 56 }}>{eventEmoji(e)}</div>
          <div style={{ flex: 1 }}>
            <h1 data-testid="event-title">{e.title}</h1>
            <p className="muted">{eventLabel(e)}</p>
          </div>
          <span className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
            {e.status === "cancelled" ? <Pill kind="declined">Cancelled</Pill>
              : e.status === "polling" ? <Pill kind="polling">Polling</Pill>
              : <Pill kind="scheduled">Confirmed</Pill>}
            {canEdit && (
              <button className="btn ghost sm" data-testid="edit-event-open" onClick={openEdit}>✎ Edit</button>
            )}
          </span>
        </div>
        {e.description && <p>{e.description}</p>}
        {(data.series?.length ?? 0) > 1 ? (
          <div className="stack" style={{ gap: 2 }} data-testid="hero-dates">
            {data.series!.map((occ) => (
              <div key={occ.id} className={occ.id === e.id ? "small" : "muted small"}>
                🗓️ {fmtDate(occ.starts_at, e.timezone)}
                {occ.starts_at ? ` · ${fmtDateTime(occ.starts_at, e.timezone).split(", ").pop()}` : ""}
                {occ.id === e.id && <span className="muted"> ← this one</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="muted small">
            🗓️ {e.status === "polling" ? "Time being decided" : fmtDate(e.starts_at, e.timezone)}
            {e.status !== "polling" && e.starts_at ? ` · ${fmtDateTime(e.starts_at, e.timezone).split(", ").pop()}` : ""}
            {e.status !== "polling" && e.ends_at ? ` – ${fmtDateTime(e.ends_at, e.timezone).split(", ").pop()}` : ""}
          </div>
        )}
        <div className="muted small">
          {e.location_mode === "find_venue" ? "📍 Venue to be decided"
            : e.location_address ? (
              <span className="stack" style={{ gap: 2 }}>
                <span>📍 {e.location_address}</span>
                <span className="row" style={{ gap: 12 }}>
                  <a href={mapsUrl(e.location_address)} target="_blank" rel="noopener noreferrer"
                    className="accent" data-testid="directions-link">Google Maps ↗</a>
                  <a href={appleMapsUrl(e.location_address)} target="_blank" rel="noopener noreferrer"
                    className="accent" data-testid="directions-apple">Apple Maps ↗</a>
                </span>
              </span>
            ) : "📍 Address to come"}
        </div>
      </div>
    );
  }

  return (
    <form className="card stack" data-testid="hero-edit" onSubmit={save}>
      {photo && <img className="event-cover" data-testid="event-cover" src={photo} alt="" />}
      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className="btn ghost sm" data-testid="cover-upload"
          onClick={() => fileRef.current?.click()}>{photo ? "Change photo" : "📷 Add a photo"}</button>
        {photo && (
          <button type="button" className="btn ghost sm" data-testid="cover-remove" onClick={() => setPhoto("")}>Remove</button>
        )}
        <input ref={fileRef} type="file" accept="image/*" data-testid="cover-file"
          style={{ display: "none" }} onChange={onPickPhoto} />
      </div>
      <GifPicker onPick={(url) => setPhoto(url)} />
      <input className="input" data-testid="edit-title" value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="Title" />
      <textarea className="input" data-testid="edit-desc" value={desc} rows={2} onChange={(ev) => setDesc(ev.target.value)} placeholder="Description" />
      {e.status === "scheduled" && (
        <>
          <label className="field">{sibs.length > 0 ? "This date" : "When"}
            <input type="datetime-local" className="input" min={toDatetimeLocal(new Date().toISOString())} data-testid="edit-time"
              value={startsAt} onChange={(ev) => setStartsAt(ev.target.value)} />
          </label>
          <label className="field">Ends <span className="muted small">(optional)</span>
            <input type="datetime-local" className="input" min={startsAt || undefined} data-testid="edit-end"
              value={endsAt} onChange={(ev) => setEndsAt(ev.target.value)} />
          </label>
        </>
      )}
      {sibs.map((occ, i) => (
        <label className="field" key={occ.id}>Date {i + 2} of the series
          <input type="datetime-local" className="input" min={toDatetimeLocal(new Date().toISOString())}
            data-testid={`edit-time-sib-${i}`} value={sibValue(occ.id, occ.starts_at!)}
            onChange={(ev) => setSibTimes((m) => ({ ...m, [occ.id]: ev.target.value }))} />
        </label>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className={locMode === "host_place" ? "btn sm" : "btn ghost sm"}
          data-testid="edit-loc-host" onClick={() => setLocMode("host_place")}>Set an address</button>
        <button type="button" className={locMode === "find_venue" ? "btn sm" : "btn ghost sm"}
          data-testid="edit-loc-venue" onClick={() => setLocMode("find_venue")}>Find a venue</button>
      </div>
      {locMode === "host_place" && (
        <AddressInput value={locAddr} onChange={setLocAddr} placeholder="Start typing an address…" testid="edit-address" />
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="muted small">Who can find it:</span>
        {([["private", "🔒 Invite-only"], ["friends", "🤝 Friends"], ["public", "🌎 Public"]] as const).map(([v, l]) => (
          <button key={v} type="button" className={`chip sm ${visibility === v ? "on" : ""}`}
            data-testid={`edit-vis-${v}`} onClick={() => setVisibility(v)}>{l}</button>
        ))}
      </div>
      {visibility === "public" && (
        <>
          <div className="row wrap" style={{ gap: 4 }}>
            {CATEGORIES.map((c) => (
              <button key={c.slug} type="button" className={`chip sm ${topic === c.slug ? "on" : ""}`}
                data-testid={`edit-cat-${c.slug}`}
                onClick={() => setTopic(topic === c.slug ? "" : c.slug)}>{c.emoji} {c.label}</button>
            ))}
          </div>
          <input className="input" data-testid="edit-city" list="edit-city-list" value={city}
            placeholder="city (optional)" onChange={(ev) => setCity(ev.target.value)} />
          <datalist id="edit-city-list">
            {CITY_OPTIONS.map((c) => <option key={c} value={c} />)}
          </datalist>
        </>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="muted small">Theme:</span>
        {EVENT_THEMES.map((t) => (
          <button key={t.value} type="button" className={`chip sm ${theme === t.value ? "on" : ""}`}
            data-testid={`theme-${t.value || "none"}`}
            onClick={() => { setTheme(t.value); onPreviewTheme(t.value || null); }}>{t.label}</button>
        ))}
      </div>
      {(data.series?.length ?? 0) > 1 && (
        <label className="row small" style={{ gap: 6, cursor: "pointer" }}>
          <input type="checkbox" data-testid="edit-apply-series" checked={applySeries}
            onChange={(ev2) => setApplySeries(ev2.target.checked)} />
          Apply to all {data.series!.length} dates in this series (each keeps its own time)
        </label>
      )}
      {msg && <p className="err small">{msg}</p>}
      <div className="row">
        <button className="btn" data-testid="edit-save">Save changes</button>
        <button type="button" className="btn ghost sm" data-testid="edit-cancel" onClick={() => { setEditing(false); onPreviewTheme(null); }}>Cancel</button>
      </div>
    </form>
  );
}

// Host-only controls: toggle the comment thread + manage cohosts.
function HostControls({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const e = data.event;
  const [handle, setHandle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function toggleComments() {
    await sendJSON(api, "PUT", `/api/events/${e.id}/comments-enabled`, { enabled: !e.comments_enabled });
    reload();
  }
  async function addCohost(ev: React.FormEvent) {
    ev.preventDefault();
    setMsg(null);
    const res = await sendJSON(api, "POST", `/api/events/${e.id}/cohosts`, { handle });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setMsg(b.error || "could not add");
    }
    setHandle("");
    reload();
  }
  async function removeCohost(uid: string) {
    await api(`/api/events/${e.id}/cohosts/${uid}`, { method: "DELETE" });
    reload();
  }

  return (
    <div className="card stack" data-testid="host-controls">
      <h3 style={{ margin: 0 }}>Host controls</h3>
      <div className="row between">
        <span className="small">Comments are <strong>{e.comments_enabled ? "on" : "off"}</strong></span>
        <button className="btn soft sm" data-testid="toggle-comments" onClick={toggleComments}>
          {e.comments_enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      <div className="section-h">Cohosts</div>
      <p className="muted small" style={{ margin: 0 }}>Cohosts can edit the event, share the invite, and moderate comments.</p>
      {data.cohosts.map((c) => (
        <div key={c.user_id} className="row between" data-testid="cohost">
          <span>{c.display_name || c.handle} <span className="muted small">@{c.handle}</span></span>
          <button className="btn ghost sm" data-testid={`cohost-remove-${c.handle}`} onClick={() => removeCohost(c.user_id)}>Remove</button>
        </div>
      ))}
      <form className="row" onSubmit={addCohost}>
        <input className="input" data-testid="cohost-handle" value={handle} onChange={(ev) => setHandle(ev.target.value)} placeholder="friend's handle" />
        <button className="btn sm" data-testid="cohost-add">Add cohost</button>
      </form>
      {msg && <p className="muted small">{msg}</p>}

      <div className="section-h">Danger zone</div>
      <div className="row wrap">
        <ConfirmButton label="Cancel event" confirmLabel="Tap again — guests will see it as cancelled" testid="cancel-event"
          onConfirm={async () => { await api(`/api/events/${e.id}`, { method: "DELETE" }); reload(); }} />
        {e.series_id && (
          <ConfirmButton label="Cancel whole series" confirmLabel="Tap again — cancels EVERY date" testid="cancel-series"
            onConfirm={async () => { await api(`/api/events/${e.id}?series=all`, { method: "DELETE" }); reload(); }} />
        )}
      </div>
    </div>
  );
}

// The comment thread — visible to everyone; composer shows when comments are on.
function EventComments({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const e = data.event;
  const [body, setBody] = useState("");
  const [gif, setGif] = useState("");      // a picked Klipy gif riding on the next post
  const [picking, setPicking] = useState(false);

  async function post() {
    if (!body.trim() && !gif) return;
    const res = await sendJSON(api, "POST", `/api/events/${e.id}/comments`, { body, gif_url: gif });
    if (res.ok) {
      setBody("");
      setGif("");
      setPicking(false);
      reload();
    }
  }
  async function del(cid: string) {
    await api(`/api/events/${e.id}/comments/${cid}`, { method: "DELETE" });
    reload();
  }

  return (
    <div className="card stack" data-testid="comments">
      <h3 style={{ margin: 0 }}>Comments</h3>
      {data.comments.length === 0 && <p className="muted small">No comments yet.</p>}
      {data.comments.map((c, i) => (
        <div key={c.id} className="row between" data-testid="comment">
          <span className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <Avatar url={c.avatar_url} name={c.display_name} size={28} />
            <span className="stack" style={{ gap: 1 }}>
              <strong className="small">{c.display_name || "Someone"}</strong>
              {c.body && <span>{c.body}</span>}
              {c.gif_url && <img className="comment-gif" data-testid="comment-gif" src={c.gif_url} alt="gif" loading="lazy" />}
            </span>
          </span>
          {(c.user_id === data.viewer_id || data.can_manage) && (
            <button className="btn ghost sm" data-testid={`comment-delete-${i}`} onClick={() => del(c.id)}>Delete</button>
          )}
        </div>
      ))}
      {e.comments_enabled ? (
        <div className="stack" style={{ gap: 6 }}>
          {gif && (
            <span className="row" style={{ gap: 6 }}>
              <img className="comment-gif" data-testid="comment-gif-preview" src={gif} alt="chosen gif" />
              <button type="button" className="btn ghost sm" onClick={() => setGif("")}>✕</button>
            </span>
          )}
          <div className="row">
            <input className="input" data-testid="comment-input" value={body} placeholder="Add a comment…"
              onChange={(ev) => setBody(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && post()} />
            <button type="button" className="btn ghost sm" data-testid="comment-gif-open"
              onClick={() => setPicking((p) => !p)}>GIF</button>
            <button className="btn sm" data-testid="comment-post" onClick={post}>Post</button>
          </div>
          {picking && <GifPicker onPick={(url) => { setGif(url); setPicking(false); }} />}
        </div>
      ) : (
        <p className="muted small" data-testid="comments-off">Comments are turned off for this event.</p>
      )}
    </div>
  );
}

function ShareLink({ eventId }: { eventId: string }) {
  const url = `${location.origin}/e/${eventId}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="card stack">
      <h3>Invite people</h3>
      <p className="muted small">Share this link — anyone who opens it can RSVP.</p>
      <div className="row">
        <input className="input" readOnly value={url} data-testid="share-link" onFocus={(ev) => ev.currentTarget.select()} />
        <button className="btn soft sm" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); analytics.capture(EVENTS.shareLinkCopied); }}>
          {copied ? "Copied" : "Copy"}
        </button>
        {typeof navigator.share === "function" && (
          <button className="btn sm" data-testid="share-native"
            onClick={() => { navigator.share({ title: "Whensdays invite", url }).catch(() => {}); analytics.capture(EVENTS.shareLinkCopied, { via: "native" }); }}>
            Share…
          </button>
        )}
      </div>
    </div>
  );
}

function PollResults({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const voters = new Set(data.votes.map((v) => v.user_id)).size || 1;
  const yesFor = (o: TimeOption) => data.votes.filter((v) => v.option_id === o.id && v.response === "yes").length;
  // Rank best-first: explicit yes-votes, then how the slot fits EVERYONE's
  // saved availability (server-computed across all attendees, not just the
  // viewer) — the "it just knows" ranking.
  const fitOf = (o: TimeOption) => data.option_fit?.[o.id] ?? { free: 0, busy: 0 };
  const ranked = [...data.time_options].sort((a, b) =>
    (yesFor(b) - yesFor(a)) || (fitOf(b).free - fitOf(a).free) || (fitOf(a).busy - fitOf(b).busy));
  async function finalize(o: TimeOption) {
    await sendJSON(api, "POST", `/api/events/${data.event.id}/finalize`, { starts_at: o.starts_at });
    reload();
  }
  // Multi-pick: tap several options, schedule them all as one series (everyone
  // carried onto each date, RSVPs intact).
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const toggleMulti = (id: string) => setMulti((m) => {
    const next = new Set(m);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  async function finalizeMulti() {
    const times = ranked.filter((o) => multi.has(o.id)).map((o) => o.starts_at).sort();
    if (times.length === 0) return;
    await sendJSON(api, "POST", `/api/events/${data.event.id}/finalize`, {
      starts_at: times[0], more_starts: times.slice(1),
    });
    reload();
  }
  return (
    <div className="card stack">
      <h3>Availability</h3>
      {ranked.map((o, i) => {
        const yes = yesFor(o);
        return (
          <div key={o.id} className="stack" style={{ gap: 4 }}>
            <div className="row between">
              <span className="small">
                {fmtDateTime(o.starts_at)}
                {i === 0 && (yes > 0 || fitOf(o).free > 0) && <span className="pill scheduled" style={{ marginLeft: 6 }}>Best</span>}
                {(fitOf(o).free > 0 || fitOf(o).busy > 0) && (
                  <span className="muted small" style={{ marginLeft: 6 }} data-testid={`fit-${i}`}>
                    {fitOf(o).free > 0 && <>🟢 {fitOf(o).free} free</>}
                    {fitOf(o).free > 0 && fitOf(o).busy > 0 && " · "}
                    {fitOf(o).busy > 0 && <>🔴 {fitOf(o).busy} busy</>}
                  </span>
                )}
              </span>
              <div className="row">
                <span className="muted small">{yes} available</span>
                <button type="button" className={`chip sm ${multi.has(o.id) ? "on" : ""}`} data-testid={`select-${i}`}
                  onClick={() => toggleMulti(o.id)} title="Select several, then schedule them together">
                  {multi.has(o.id) ? "Selected ✓" : "Select"}
                </button>
                <button className="btn sm" data-testid={`finalize-${i}`} onClick={() => finalize(o)}>Pick</button>
              </div>
            </div>
            <div className="tally"><span style={{ width: `${(yes / voters) * 100}%` }} /></div>
          </div>
        );
      })}
      {multi.size > 0 && (
        <button className="btn" style={{ alignSelf: "flex-start" }} data-testid="finalize-multi" onClick={finalizeMulti}>
          Schedule {multi.size} date{multi.size > 1 ? "s" : ""} as a series
        </button>
      )}
    </div>
  );
}

// Aggregates the general poll for the host, shaped by the event's scope:
//   week    → a dates × dayparts heatmap over the event's 7-day window
//   month   → a ranked list of the most-picked days
//   general → month ranking + weekday×daypart heatmap (the original)
// Darker = more people free; then the host finalizes a concrete time.
function GeneralResults({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const [when, setWhen] = useState("");
  const scope = data.event.general_scope;

  const voters = new Set(data.general_votes.map((v) => v.user_id)).size;

  // Per-guest view: tap a responder's dot to see exactly what THEY picked,
  // overlaid on the aggregate. Names/photos come from the attendee list.
  const [sel, setSel] = useState<string | null>(null);
  const responders = [...new Set(data.general_votes.map((v) => v.user_id))].map((uid) => {
    const a = data.attendees.find((x) => x.user_id === uid);
    return { id: uid, name: a?.display_name || "Guest", avatar: a?.avatar_url ?? null };
  });
  const selVals = new Set(sel ? data.general_votes.filter((v) => v.user_id === sel).map((v) => v.value) : []);
  // With a responder selected, make their availability unmistakable: their
  // picks fill + glow in the accent while every other cell fades right back.
  // (A subtle border alone was unreadable over the heat colors.)
  const pickedStyle = (value: string): React.CSSProperties => {
    if (!sel) return {};
    return selVals.has(value)
      ? {
          background: "color-mix(in srgb, var(--accent) 38%, transparent)",
          boxShadow: "inset 0 0 0 2px var(--accent), 0 0 12px color-mix(in srgb, var(--accent) 50%, transparent)",
          position: "relative", zIndex: 1,
        }
      : { opacity: 0.22, filter: "saturate(0.35)" };
  };

  const countBy = (dimension: string) => {
    const m = new Map<string, number>();
    data.general_votes.filter((v) => v.dimension === dimension)
      .forEach((v) => m.set(v.value, (m.get(v.value) ?? 0) + 1));
    return m;
  };
  const heatStyle = (n: number, top: number): React.CSSProperties =>
    n === 0 ? {} : { background: `rgba(238, 108, 77, ${0.18 + 0.82 * (n / top)})`, borderColor: "transparent", color: "#fff" };

  // general scope: month ranking + weekday×daypart heatmap.
  const monthCounts = countBy("month");
  const months = [...monthCounts.entries()].sort((a, b) => b[1] - a[1]);
  const monthLabel = (v: string) => {
    const [y, mo] = v.split("-").map(Number);
    return new Date(y, mo - 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };
  const monthTop = Math.max(1, ...monthCounts.values());
  const slotCounts = countBy("slot");
  const slotTop = Math.max(1, ...slotCounts.values());

  // week scope: dates × dayparts heatmap over the event's answer window.
  const weekDates = daysFromDate(data.event.created_at, 7);
  const monthDates28 = daysFromDate(data.event.created_at, 28);
  const dayslotCounts = countBy("dayslot");
  const dayslotTop = Math.max(1, ...dayslotCounts.values());

  // month scope: ranked days.
  const dayCounts = countBy("day");
  const days = [...dayCounts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const dayTop = Math.max(1, ...dayCounts.values());
  const dayLabel = (v: string) => {
    const [y, mo, d] = v.split("-").map(Number);
    return new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  // Multi-date finalize: the host TAPS winning cells right on the results (or
  // types times manually) — one or several. Extra dates become a series with
  // everyone (RSVPs intact) carried onto each occurrence.
  const [moreWhens, setMoreWhens] = useState<string[]>([]);
  // picked: heat-cell selections, cellKey -> datetime-local (daypart mapped to
  // a sensible start hour; the host can still fine-tune via the manual inputs).
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const canPick = data.can_manage;
  const togglePick = (key: string, dtLocal: string) => {
    if (!canPick) return;
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(key)) next.delete(key);
      else next.set(key, dtLocal);
      return next;
    });
  };
  const cellPickStyle = (key: string): React.CSSProperties =>
    picked.has(key)
      ? { outline: "3px solid var(--accent)", outlineOffset: "-3px", position: "relative", zIndex: 2 }
      : {};
  // next concrete date for a weekday (general scope cells aren't dated)
  const nextDateOfWeekday = (wd: number, hour: number) => {
    const d = new Date();
    do { d.setDate(d.getDate() + 1); } while (d.getDay() !== wd);
    d.setHours(hour, 0, 0, 0);
    return toDatetimeLocal(d.toISOString());
  };
  async function finalize() {
    const all = [when, ...moreWhens, ...picked.values()].filter((v) => v.trim() !== "")
      .map((v) => new Date(v).toISOString()).sort();
    if (all.length === 0) return;
    await sendJSON(api, "POST", `/api/events/${data.event.id}/finalize`, {
      starts_at: all[0], more_starts: all.slice(1),
    });
    reload();
  }
  const pickCount = [when, ...moreWhens].filter((v) => v.trim() !== "").length + picked.size;

  return (
    <div className="card stack">
      <div className="row between"><h3>Group availability</h3><span className="muted small">{voters} responded</span></div>

      {scope === "week" && (
        <div>
          <div className="section-h" style={{ margin: "0 0 4px" }}>Best times this week</div>
          {dayslotCounts.size === 0 ? <p className="muted small">No picks yet.</p> : (
            <div className="grid" style={{ gridTemplateColumns: `auto repeat(${DAYPARTS.length}, 1fr)` }} data-testid="gr-week-heat">
              <div />
              {DAYPARTS.map((dp) => <div key={dp.value} className="hd">{dp.short}</div>)}
              {weekDates.map((d) => (
                <Fragment key={d.value}>
                  <div className="day" style={{ textAlign: "left" }}>{d.label}</div>
                  {DAYPARTS.map((dp) => {
                    const key = `${d.value}:${dp.value}`;
                    const n = dayslotCounts.get(key) ?? 0;
                    return (
                      <button key={dp.value} type="button" className="cell" data-testid={`grw-pick-${d.value}-${dp.value}`}
                        onClick={() => togglePick(key, `${d.value}T${String(DAYPART_HOUR[dp.value]).padStart(2, "0")}:00`)}
                        style={{ ...heatStyle(n, dayslotTop), ...pickedStyle(key), ...cellPickStyle(key), display: "grid", placeItems: "center", fontSize: "0.8rem", fontWeight: 700, cursor: canPick ? "pointer" : "default" }}>
                        {n > 0 ? n : ""}
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {scope === "month" && (
        <div>
          <div className="section-h" style={{ margin: "0 0 4px" }}>Best times over the next 4 weeks</div>
          {dayslotCounts.size === 0 && days.length > 0 ? (
            /* legacy events answered as day-only chips */
            <div className="stack" style={{ gap: 4 }} data-testid="gr-month-days">
              {days.map(([value, n]) => (
                <div key={value} className="stack" style={{ gap: 2, ...pickedStyle(value), paddingLeft: sel && selVals.has(value) ? 6 : 0 }}>
                  <div className="row between"><span className="small">{dayLabel(value)}</span><span className="muted small">{n}</span></div>
                  <div className="tally"><span style={{ width: `${(n / dayTop) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          ) : dayslotCounts.size === 0 ? <p className="muted small">No picks yet.</p> : (
            <div className="grid" style={{ gridTemplateColumns: `auto repeat(${DAYPARTS.length}, 1fr)` }} data-testid="gr-month-heat">
              <div />
              {DAYPARTS.map((dp) => <div key={dp.value} className="hd">{dp.short}</div>)}
              {monthDates28.map((d) => (
                <Fragment key={d.value}>
                  <div className="day" style={{ textAlign: "left" }}>{d.label}</div>
                  {DAYPARTS.map((dp) => {
                    const key = `${d.value}:${dp.value}`;
                    const n = dayslotCounts.get(key) ?? 0;
                    return (
                      <button key={dp.value} type="button" className="cell" data-testid={`grm-pick-${d.value}-${dp.value}`}
                        onClick={() => togglePick(key, `${d.value}T${String(DAYPART_HOUR[dp.value]).padStart(2, "0")}:00`)}
                        style={{ ...heatStyle(n, dayslotTop), ...pickedStyle(key), ...cellPickStyle(key), display: "grid", placeItems: "center", fontSize: "0.8rem", fontWeight: 700, cursor: canPick ? "pointer" : "default" }}>
                        {n > 0 ? n : ""}
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {scope === "general" && (
        <>
          <div>
            <div className="section-h" style={{ margin: "0 0 4px" }}>Months</div>
            {months.length === 0 ? <p className="muted small">No picks yet.</p> : (
              <div className="stack" style={{ gap: 4 }}>
                {months.map(([value, n]) => (
                  <div key={value} className="stack" style={{ gap: 2, ...pickedStyle(value), paddingLeft: sel && selVals.has(value) ? 6 : 0 }}>
                    <div className="row between"><span className="small">{monthLabel(value)}</span><span className="muted small">{n}</span></div>
                    <div className="tally"><span style={{ width: `${(n / monthTop) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="section-h" style={{ margin: "0 0 4px" }}>Best times</div>
            <div className="grid" style={{ gridTemplateColumns: "auto repeat(7, 1fr)" }}>
              <div />
              {WEEKDAYS.map((d, wd) => <div key={wd} className="hd">{d}</div>)}
              {DAYPARTS.map((dp) => (
                <Fragment key={dp.value}>
                  <div className="day" style={{ textAlign: "left" }}>{dp.label}</div>
                  {WEEKDAYS.map((_, wd) => {
                    const key = slotKey(wd, dp.value);
                    const n = slotCounts.get(key) ?? 0;
                    return (
                      <button key={wd} type="button" className="cell" data-testid={`grg-pick-${wd}-${dp.value}`}
                        onClick={() => togglePick(key, nextDateOfWeekday(wd, DAYPART_HOUR[dp.value]))}
                        style={{ ...heatStyle(n, slotTop), ...pickedStyle(key), ...cellPickStyle(key), display: "grid", placeItems: "center", fontSize: "0.8rem", fontWeight: 700, cursor: canPick ? "pointer" : "default" }}>
                        {n > 0 ? n : ""}
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </>
      )}

      {responders.length > 0 && (
        <div className="stack" style={{ gap: 6 }} data-testid="responder-dots">
          <div className="row between">
            <div className="section-h" style={{ margin: 0 }}>Who responded</div>
            {sel && <button className="btn ghost sm" data-testid="responders-all" onClick={() => setSel(null)}>Show everyone</button>}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {responders.map((r) => (
              <button key={r.id} type="button" title={r.name}
                className={`resp-dot ${sel === r.id ? "on" : ""}`} data-testid={`responder-${r.id}`}
                onClick={() => setSel(sel === r.id ? null : r.id)}>
                <Avatar url={r.avatar} name={r.name} size={30} />
              </button>
            ))}
          </div>
          <p className="muted small">
            {sel
              ? `Highlighting ${responders.find((r) => r.id === sel)?.name}'s picks — tap again for everyone.`
              : "Tap someone to see exactly what they picked."}
          </p>
        </div>
      )}

      <div className="divider" />
      <div className="muted small">
        {canPick ? "Tap winning cells above to schedule them" : "Pick the winning date & time"}
        {canPick ? " — or type times manually:" : ":"}
      </div>
      {picked.size > 0 && (
        <div className="row wrap" style={{ gap: 6 }} data-testid="picked-cells">
          {[...picked.entries()].map(([key, v]) => (
            <button key={key} type="button" className="chip sm on" data-testid={`picked-${key}`}
              onClick={() => togglePick(key, v)} title="Tap to remove">
              {fmtDateTime(new Date(v).toISOString())} ✕
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <input type="datetime-local" className="input" min={toDatetimeLocal(new Date().toISOString())} data-testid="general-finalize-time" value={when}
          onChange={(ev) => setWhen(ev.target.value)} />
      </div>
      {moreWhens.map((v, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input type="datetime-local" className="input" min={toDatetimeLocal(new Date().toISOString())} data-testid={`general-finalize-time-${i + 1}`} value={v}
            onChange={(ev) => setMoreWhens((m) => m.map((x, j) => (j === i ? ev.target.value : x)))} />
          <button type="button" className="btn ghost sm" data-testid={`general-finalize-remove-${i + 1}`}
            onClick={() => setMoreWhens((m) => m.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="row wrap">
        <button type="button" className="btn ghost sm" data-testid="general-add-date"
          onClick={() => setMoreWhens((m) => [...m, ""])}>+ Add another date</button>
        <button className="btn sm" data-testid="general-finalize" disabled={pickCount === 0} onClick={finalize}>
          {pickCount > 1 ? `Schedule ${pickCount} dates` : "Finalize"}
        </button>
      </div>
      {pickCount > 1 && (
        <p className="muted small">All {pickCount} dates become one series — everyone here is on each date, RSVPs carried over.</p>
      )}
    </div>
  );
}

// Who's coming — grouped by RSVP so it's scannable at a glance. Any real
// (non-guest) attendee who isn't already your friend gets an "Add friend"
// button right here, so an event is a place to grow your circle.
function Guests({ attendees, viewerId }: { attendees: Attendee[]; viewerId: string }) {
  const api = useApi();
  const { data: fr, reload } = useAsync<{ friends: Friend[]; outgoing: { handle?: string }[] }>(
    (a) => getJSON(a, "/api/friends"),
  );
  const [requested, setRequested] = useState<Set<string>>(new Set());

  const friendIds = new Set((fr?.friends ?? []).map((f) => f.friend_id));
  const pending = new Set((fr?.outgoing ?? []).map((o) => o.handle).filter(Boolean) as string[]);
  // Guests have no account to befriend from — they still see the full list.
  const viewerIsGuest = viewerId.startsWith("guest_");

  async function addFriend(handle: string) {
    setRequested((s) => new Set(s).add(handle));
    const res = await sendJSON(api, "POST", "/api/friends", { handle });
    if (!res.ok) setRequested((s) => { const n = new Set(s); n.delete(handle); return n; });
    else reload();
  }

  const GROUPS: { key: Attendee["rsvp"]; label: string }[] = [
    { key: "going", label: "Going" },
    { key: "maybe", label: "Maybe" },
    { key: "declined", label: "Can't go" },
  ];

  const total = attendees.length;
  const going = attendees.filter((a) => a.rsvp === "going").length;

  return (
    <div className="card stack" data-testid="guests">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Who's coming</h3>
        <span className="muted small">{going} going · {total} responded</span>
      </div>
      {total === 0 && <p className="muted small">No responses yet — share the link to get RSVPs.</p>}

      {GROUPS.map(({ key, label }) => {
        const rows = attendees.filter((a) => a.rsvp === key);
        if (rows.length === 0) return null;
        return (
          <div key={key} className="stack" style={{ gap: 6 }} data-testid={`rsvp-group-${key}`}>
            <div className="section-h" style={{ margin: 0 }}>{label} · {rows.length}</div>
            {rows.map((a) => {
              const isSelf = a.user_id === viewerId;
              const canAdd = !viewerIsGuest && !!a.handle && !isSelf && !friendIds.has(a.user_id);
              const already = a.handle ? (pending.has(a.handle) || requested.has(a.handle)) : false;
              return (
                <div key={a.user_id} className="row between" data-testid="guest-row">
                  <span className="row" style={{ gap: 8 }}>
                    <Avatar url={a.avatar_url} name={a.display_name} size={28} />
                    <span className="stack" style={{ gap: 0 }}>
                      <span>{a.display_name || "Guest"}{isSelf && <span className="muted small"> (you)</span>}</span>
                      {a.handle && <span className="muted small">@{a.handle}</span>}
                    </span>
                  </span>
                  {canAdd ? (
                    already ? (
                      <span className="muted small" data-testid={`friend-requested-${a.handle}`}>Requested ✓</span>
                    ) : (
                      <button className="btn soft sm" data-testid={`add-friend-${a.handle}`}
                        onClick={() => addFriend(a.handle!)}>+ Add friend</button>
                    )
                  ) : friendIds.has(a.user_id) ? (
                    <span className="muted small">Friends ✓</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function AnswerSummary({ data }: { data: EventDetail }) {
  if (data.preference_answers.length === 0) return null;
  const byUser = new Map<string, { name: string; answers: PrefAnswer[] }>();
  for (const a of data.preference_answers) {
    const entry = byUser.get(a.user_id) ?? { name: a.display_name || "Someone", answers: [] };
    entry.answers.push(a);
    byUser.set(a.user_id, entry);
  }
  return (
    <div className="card stack">
      <h3>Preferences</h3>
      {[...byUser.values()].map((u, i) => (
        <div key={i} className="small stack" style={{ gap: 2 }}>
          <strong>{u.name}</strong>
          {u.answers.map((a) => (
            <span key={a.question_key} className="muted">{questionLabel(data.event.event_type, a.question_key)}: {a.answer}</span>
          ))}
        </div>
      ))}
    </div>
  );
}
