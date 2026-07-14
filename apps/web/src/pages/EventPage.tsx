import { Fragment, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Attendee,
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
  TYPE_COLORS,
  busyConflict,
  daysFromDate,
  dayLabel as dayCol,
  fmtDate,
  fmtDateTime,
  fmtMinutes,
  gridSlots,
  toDatetimeLocal,
  getJSON,
  guessCity,
  importedBusy,
  mapsUrl,
  appleMapsUrl,
  openGoogleMaps,
  isStandalone,
  nextMonths,
  sendJSON,
  timeAgo,
  useApi,
} from "../lib";
import { QUESTIONS, eventEmoji, eventLabel, questionLabel } from "../scheduler/questions";
import { AddressInput, Avatar, BackLink, ConfirmButton, CropModal, DayGrid, EventSkeleton, GifPicker, HomescreenPrompt, Linkify, Pill, QRButton, TimeGrid, fileToPhoto, useAsync } from "../ui";
import { EVENTS, analytics } from "../analytics";
import { DEV_AUTH, GuestSignupButton } from "../App";

// A poll with a close date stops taking votes after it (server-enforced too).
function pollClosed(e: { status: string; poll_deadline: string | null }): boolean {
  return e.status === "polling" && !!e.poll_deadline && new Date(e.poll_deadline).getTime() < Date.now();
}

// Native min-validation would block dev/E2E backdating - server enforces the
// same rule with the same dev exemption.
const MIN_DT = DEV_AUTH ? undefined : toDatetimeLocal(new Date().toISOString());


export function EventPage() {
  const { id } = useParams();
  const api = useApi();
  const { data, loading, reload } = useAsync<EventDetail>((a) => getJSON(a, `/api/events/${id}`), [id]);
  const [preview, setPreview] = useState(false);
  // Live theme preview while editing the hero card - reflects the whole page
  // before the edit is saved. null = show the saved theme.
  const [themePreview, setThemePreview] = useState<string | null>(null);
  // The lock moment: when this session watches the status flip polling →
  // scheduled, celebrate - a one-shot confetti burst + banner. Catching the
  // transition here (rather than in each finalize button) covers every path.
  const prevStatus = useRef<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  // One-time add-to-homescreen prompt: fires on the event page right after
  // this device's FIRST event creation (see the create flows), phones only.
  const [showA2HS, setShowA2HS] = useState(false);
  useEffect(() => {
    try {
      if (
        sessionStorage.getItem("whensdays.a2hs-pending") &&
        !localStorage.getItem("whensdays.a2hs") &&
        window.matchMedia("(max-width: 640px)").matches &&
        !isStandalone()
      ) setShowA2HS(true);
    } catch { /* private mode */ }
  }, []);
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

  if (loading && !data) return <EventSkeleton />;
  if (!data) return <div className="stack"><BackLink /><p className="muted">Event not found.</p></div>;

  const showManage = data.can_manage && !preview;
  const e = data.event;
  const effTheme = themePreview ?? e.theme;

  return (
    <div className={`stack ${effTheme ? `event-theme theme-${effTheme}` : ""}`}>
      {celebrate && <div className="fx-locked" data-testid="locked-banner">It&rsquo;s locked in 🎉</div>}
      {data.event.status === "draft" && data.can_manage && (
        <div className="card row between" data-testid="draft-banner">
          <span className="small">📝 <strong>Draft</strong> - only you{data.cohosts.length > 0 ? " and cohosts" : ""} can see this. Guests, emails, and reminders are paused.</span>
          <button className="btn sm" style={{ flex: "none" }} data-testid="draft-publish"
            onClick={async () => { await sendJSON(api, "POST", `/api/events/${data.event.id}/draft`, { draft: false }); reload(); }}>
            Publish
          </button>
        </div>
      )}
      {showA2HS && <HomescreenPrompt onClose={() => { setShowA2HS(false); try { localStorage.setItem("whensdays.a2hs", "1"); sessionStorage.removeItem("whensdays.a2hs-pending"); } catch { /* private mode */ } }} />}
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

// Per-event notification mute - available to anyone on the event (host or
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
      {muted ? "🔕 Notifications muted - turn back on" : "🔔 Mute notifications"}
    </button>
  );
}

// ---------------- recurring series ----------------

// Representative start hour per daypart - used when the host schedules straight
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
            {fmtDate(s.starts_at, data.event.timezone)}
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

// Builds an "Add to Google Calendar" template URL entirely client-side - no API
// call or account needed. Matches the API's 2h default export duration.
function googleCalendarUrl(e: EventDetail["event"]): string {
  const start = new Date(e.starts_at!);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const location = e.location_mode === "find_venue" ? "Location to be decided" : e.location_address || "Address to come";
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
      <p className="muted small" style={{ margin: 0 }}>One tap - title, time and a link back to this page ride along.</p>
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
      <Rsvp eventId={e.id} current={myRsvp} reload={reload} isGuest={data.viewer_id.startsWith("guest_")} />
      {pollClosed(e) && (
        <div className="card" data-testid="poll-closed">
          <span className="muted small">🗳️ This poll has closed - the host is picking the time. You'll get the locked-in email.</span>
        </div>
      )}
      {e.scheduling_mode === "poll" && e.status === "polling" && !pollClosed(e) && (
        <PollVote eventId={e.id} options={data.time_options} votes={data.votes} viewerId={data.viewer_id} tz={e.timezone} reload={reload} />
      )}
      {e.scheduling_mode === "general" && e.status === "polling" && !pollClosed(e) && (
        <GeneralPoll event={e} votes={data.general_votes} viewerId={data.viewer_id}
          days={data.poll_days} grid={data.time_grid} reload={reload} />
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

// WhosIn - live social pressure above the fold on the invite page: a progress
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
        <span className="muted small" data-testid="whos-in-count">
          <b>{going.length}</b> of {total} in
          {data.event.capacity > 0 && <> · {Math.max(0, data.event.capacity - going.length)} of {data.event.capacity} spots left</>}
        </span>
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

function Rsvp({ eventId, current, reload, isGuest }: { eventId: string; current?: string; reload: () => void; isGuest?: boolean }) {
  const api = useApi();
  // OPTIMISTIC: the tap flips the selection instantly - waiting on the POST
  // plus a full event refetch before showing the choice felt broken (Cloud Run
  // + Neon round-trips add up). Server sync + reload happen in the background;
  // a failed POST reverts the flip.
  const [sel, setSel] = useState<string | undefined>(undefined);
  const active = sel ?? current;
  function set(rsvp: string) {
    const prev = active;
    setSel(rsvp);
    sendJSON(api, "POST", `/api/events/${eventId}/rsvp`, { rsvp })
      .then(async (res) => {
        if (!res.ok) return setSel(prev);
        // The server may convert a "going" on a full event into a waitlist
        // spot - land on what it actually stored.
        const a = await res.json().catch(() => null);
        if (a?.rsvp) setSel(a.rsvp);
        reload();
      })
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
      {active === "waitlist" && (
        <p className="muted small" style={{ margin: 0 }} data-testid="waitlist-note">
          ⏳ The event is full - you're on the waitlist. If a spot opens you're bumped in automatically (and emailed).
        </p>
      )}
      {/* The honest post-commit nudge: guests have no email on file, so
          without an account the reminder and any time change never reach
          them. Peak-intent moment - right after they said yes. */}
      {isGuest && (active === "going" || active === "maybe") && (
        <div className="row between" style={{ gap: 10 }} data-testid="rsvp-signup-nudge">
          <span className="muted small" style={{ minWidth: 0 }}>
            🔔 You're in - but guests don't get emails. Sign up (free) so the reminder and any time changes reach you.
          </span>
          <span style={{ flex: "none" }}>
            <GuestSignupButton testid="rsvp-signup" source="post_rsvp" />
          </span>
        </div>
      )}
    </div>
  );
}

function PollVote({ eventId, options, votes, viewerId, tz, reload }: {
  eventId: string; options: TimeOption[]; votes: Vote[]; viewerId: string; tz?: string; reload: () => void;
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
            {fmtDateTime(o.starts_at, tz)}
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
function GeneralPoll({ event, votes, viewerId, days, grid, reload }: {
  event: EventDetail["event"]; votes: GeneralVote[]; viewerId: string;
  days: string[] | null; grid: EventDetail["time_grid"]; reload: () => void;
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
  // 'dates' scope: "YYYY-MM-DD:<minutes>" cells on the host's chosen days.
  const [timeCells, setTimeCells] = useState<Set<string>>(
    new Set(mine.filter((v) => v.dimension === "timeslot").map((v) => v.value)),
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

  // Month scope: 28 concrete dates × dayparts - same grid as week, longer window.
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
    } else if (scope === "dates") {
      body.time_slots = [...timeCells].map((k) => {
        const [day, min] = k.split(":");
        return { day, minutes: Number(min) };
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
            <span className="muted small">Tap or slide across the times that work (a date or column header fills the line)</span>
            <button type="button" className="btn ghost sm" data-testid="gpw-clear"
              disabled={dayCells.size === 0} onClick={() => mutate(setDayCells, (s) => s.clear())}>Clear</button>
          </div>
          <DayGrid dates={weekDates} free={dayCells} idPrefix="gpw" testid="gp-week-grid"
            onToggle={toggleDayCell} onToggleRow={toggleDayRow} onToggleCol={toggleDayCol}
            paintOn={dayCells}
            onPaint={(day, dp, on) => mutate(setDayCells, (s) => (on ? s.add(`${day}:${dp}`) : s.delete(`${day}:${dp}`)))} />
        </div>
      )}

      {scope === "month" && (
        <div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="muted small">Tap or slide across the times that work over the next 4 weeks (a date or column header fills the line)</span>
            <button type="button" className="btn ghost sm" data-testid="gp-days-clear"
              disabled={dayCells.size === 0} onClick={() => mutate(setDayCells, (s) => s.clear())}>Clear</button>
          </div>
          <DayGrid dates={monthDates} free={dayCells} idPrefix="gpm" testid="gp-month-grid"
            onToggle={toggleDayCell} onToggleRow={toggleDayRow} onToggleCol={toggleMonthCol}
            paintOn={dayCells}
            onPaint={(day, dp, on) => mutate(setDayCells, (s) => (on ? s.add(`${day}:${dp}`) : s.delete(`${day}:${dp}`)))} />
        </div>
      )}

      {scope === "dates" && grid && (
        <div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="muted small">Tap or slide across the times that work (tap a day or time label to fill the whole line)</span>
            <button type="button" className="btn ghost sm" data-testid="gp-times-clear"
              disabled={timeCells.size === 0} onClick={() => mutate(setTimeCells, (s) => s.clear())}>Clear</button>
          </div>
          <TimeGrid days={(days || []).map(dayCol)} slots={gridSlots(grid.start_min, grid.end_min, grid.slot_min)}
            free={timeCells} fmtSlot={fmtMinutes} idPrefix="gpt" testid="gp-time-grid"
            onToggleCol={(day) => mutate(setTimeCells, (s) => {
              const keys = gridSlots(grid.start_min, grid.end_min, grid.slot_min).map((m) => `${day}:${m}`);
              const full = keys.every((k) => s.has(k));
              keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
            })}
            onToggleRow={(m) => mutate(setTimeCells, (s) => {
              const keys = (days || []).map((d) => `${d}:${m}`);
              const full = keys.every((k) => s.has(k));
              keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
            })}
            paintOn={timeCells}
            onPaint={(day, min, on) => mutate(setTimeCells, (s) => (on ? s.add(`${day}:${min}`) : s.delete(`${day}:${min}`)))} />
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
            <div className="muted small" style={{ marginBottom: 6 }}>Times that work - tap or slide across cells (a day or column header fills the line)</div>
            {/* The shared DayGrid (weekday rows × dayparts) so slide-to-paint
                works here exactly like every other availability grid. Row
                index = weekday, so gp-cell-<wd>-<part> testids are preserved. */}
            <DayGrid
              dates={WEEKDAYS.map((d, wd) => ({ value: String(wd), label: d }))}
              free={cells} idPrefix="gp" testid="gp-general-grid"
              onToggle={(day, dp) => toggleCell(`${day}:${dp}`)}
              onToggleRow={(day) => toggleColumn(Number(day))}
              onToggleCol={(dp) => toggleRow(dp)}
              paintOn={cells}
              onPaint={(day, dp, on) => mutate(setCells, (m) => (on ? m.add(`${day}:${dp}`) : m.delete(`${day}:${dp}`)))} />
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
            <strong>{existing[q.key] || "-"}</strong>
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
        <input id="pf" className="input" maxLength={400} data-testid="pref-input" placeholder={q.placeholder}
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
      <ShareLink eventId={e.id} title={e.title} />
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

// Nudge - the host's lever for "nobody replied": one tap re-emails only the
// invited people who haven't responded (server rate-limits to once a day).
function Nudge({ data }: { data: EventDetail }) {
  const api = useApi();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const responded = new Set(data.attendees.map((a) => a.user_id));
  const pendingInvites = data.invites.filter((i) => !responded.has(i.user_id));
  const pending = pendingInvites.length;
  const opened = pendingInvites.filter((i) => i.seen).length;
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
      <span className="muted small" data-testid="invite-open-stats">{opened} of {pending} opened the invite</span>
      {msg && <span className="muted small" data-testid="nudge-msg">{msg}</span>}
    </div>
  );
}

// The hero card: cover art + title/meta, and - for the host/cohosts - an Edit
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
  // Editable start time - only meaningful once the event has a concrete time
  // (fixed or finalized); a poll still decides its time by voting.
  const [startsAt, setStartsAt] = useState(e.starts_at && e.status === "scheduled" ? toDatetimeLocal(e.starts_at) : "");
  const [deadline, setDeadline] = useState(e.poll_deadline ? toDatetimeLocal(e.poll_deadline) : "");
  const [capacity, setCapacity] = useState(e.capacity > 0 ? String(e.capacity) : "");
  const [endsAt, setEndsAt] = useState(e.ends_at ? toDatetimeLocal(e.ends_at) : "");
  // Sibling occurrences (multi-date series): every date is editable from here,
  // one input per occurrence. Keyed by sibling event id.
  const sibs = (data.series ?? []).filter((x) => x.id !== e.id && x.starts_at);
  const [sibTimes, setSibTimes] = useState<Record<string, string>>({});
  const sibValue = (id: string, iso: string) => sibTimes[id] ?? toDatetimeLocal(iso);
  // Extra dates the host adds while editing - each becomes a new occurrence.
  const [addStarts, setAddStarts] = useState<string[]>([]);
  // Series editing: apply content edits (title/details/cover/theme…) to every
  // occurrence - each keeps its own date.
  const [applySeries, setApplySeries] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function openEdit() {
    // Re-seed from the freshest event so a stale card never overwrites edits.
    setTitle(e.title); setDesc(e.description); setLocMode(e.location_mode);
    setLocAddr(e.location_address); setVisibility(e.visibility);
    setTopic(e.topic); setCity(e.city || guessCity());
    setPhoto(e.photo_url); setTheme(e.theme); setMsg(null);
    setStartsAt(e.starts_at && e.status === "scheduled" ? toDatetimeLocal(e.starts_at) : "");
    setDeadline(e.poll_deadline ? toDatetimeLocal(e.poll_deadline) : "");
    setCapacity(e.capacity > 0 ? String(e.capacity) : "");
    setEndsAt(e.ends_at ? toDatetimeLocal(e.ends_at) : "");
    setSibTimes({});
    setAddStarts([]);
    setEditing(true);
  }

  function onPickPhoto(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setCropFile(file); // CropModal takes it from here (square cover crop)
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
      add_starts: addStarts.filter((d) => d.trim() !== "").map((d) => new Date(d).toISOString()),
      poll_deadline: deadline ? new Date(deadline).toISOString() : "",
      capacity: capacity.trim() === "" ? 0 : Number(capacity),
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
        {/* The cover is the hero visual: the photo/GIF when set, otherwise a
            type-coloured emoji tile (no picture ⇒ fall back to the type emoji)
            so the title row below stays clean - no emoji crammed beside it. */}
        {e.photo_url ? (
          <img className="event-cover" data-testid="event-cover" src={e.photo_url} alt="" />
        ) : (
          <div className="event-cover event-cover-emoji" data-testid="event-cover-emoji"
            role="img" aria-label={eventLabel(e)}
            style={{ background: `linear-gradient(150deg, ${TYPE_COLORS[e.event_type]}, color-mix(in srgb, ${TYPE_COLORS[e.event_type]} 45%, #141a27))` }}>
            {eventEmoji(e)}
          </div>
        )}
        {/* Title left, status + Edit right on desktop; stacked on a phone (the
            title gets the full width instead of being squeezed to a sliver). */}
        <div className="card-header">
          <div style={{ minWidth: 0 }}>
            <h1 data-testid="event-title">{e.title}</h1>
            <p className="muted" style={{ margin: 0 }}>{eventLabel(e)}</p>
            {data.host_name && (
              <span className="row" style={{ gap: 6, marginTop: 4 }} data-testid="hosted-by">
                <Avatar url={data.host_avatar || null} name={data.host_name} size={20} />
                <span className="muted small">Hosted by <strong>{data.host_name}</strong></span>
              </span>
            )}
          </div>
          <span className="row card-actions" style={{ gap: 6, alignItems: "center" }}>
            {e.status === "cancelled" ? <Pill kind="declined">Cancelled</Pill>
              : e.status === "draft" ? <Pill kind="">Draft</Pill>
              : e.status === "polling" ? <Pill kind="polling">Polling</Pill>
              : <Pill kind="scheduled">Confirmed</Pill>}
            {canEdit && (
              <button className="btn ghost sm" data-testid="edit-event-open" onClick={openEdit}>✎ Edit</button>
            )}
          </span>
        </div>
        {e.description && <p style={{ overflowWrap: "anywhere" }}><Linkify text={e.description} /></p>}
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
            🗓️ {e.status === "polling"
            ? (e.poll_deadline
              ? (pollClosed(e) ? "Poll closed - time coming soon" : `Time being decided · poll closes ${fmtDateTime(e.poll_deadline, e.timezone)}`)
              : "Time being decided")
            : fmtDate(e.starts_at, e.timezone)}
            {e.status !== "polling" && e.starts_at ? ` · ${fmtDateTime(e.starts_at, e.timezone).split(", ").pop()}` : ""}
            {e.status !== "polling" && e.ends_at ? ` – ${fmtDateTime(e.ends_at, e.timezone).split(", ").pop()}` : ""}
          </div>
        )}
        <div className="muted small">
          {e.location_mode === "virtual" ? (
            <span className="row" style={{ gap: 8 }}>
              💻 <a href={e.location_address} target="_blank" rel="noopener noreferrer" className="accent"
                style={{ textDecoration: "underline", overflowWrap: "anywhere" }} data-testid="join-link">
                Join online{(() => { try { return ` (${new URL(e.location_address).host})`; } catch { return ""; } })()}
              </a>
            </span>
          ) : e.location_mode === "find_venue" ? "📍 Location to be decided"
            : e.location_address ? (
              <span className="stack" style={{ gap: 2 }}>
                <span>📍 {e.location_address}</span>
                <span className="row" style={{ gap: 12 }}>
                  <a href={mapsUrl(e.location_address)} target="_blank" rel="noopener noreferrer"
                    onClick={(ev) => openGoogleMaps(ev, e.location_address)}
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
        {cropFile && (
          <CropModal file={cropFile} shape="square" size={420}
            onDone={(url) => { setPhoto(url); setCropFile(null); }}
            onCancel={() => setCropFile(null)} />
        )}
      </div>
      <GifPicker onPick={(url) => setPhoto(url)} />
      <input className="input" maxLength={140} data-testid="edit-title" value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="Title" />
      <textarea className="input" maxLength={2000} data-testid="edit-desc" value={desc} rows={2} onChange={(ev) => setDesc(ev.target.value)} placeholder="Description" />
      <label className="field">Max spots <span className="muted small">(optional - beyond it people join a waitlist)</span>
        <input type="number" min={0} max={500} inputMode="numeric" className="input" data-testid="edit-capacity"
          value={capacity} placeholder="Unlimited" onChange={(ev) => setCapacity(ev.target.value)} />
      </label>
      {e.status === "polling" && (
        <label className="field">Poll closes <span className="muted small">(optional)</span>
          <span className="row" style={{ gap: 6 }}>
            <input type="datetime-local" className="input" min={MIN_DT} data-testid="edit-deadline"
              value={deadline} onChange={(ev) => setDeadline(ev.target.value)} />
            {deadline !== "" && (
              <button type="button" className="btn ghost sm" style={{ flex: "none" }} data-testid="edit-deadline-clear"
                onClick={() => setDeadline("")} title="Remove the close date">✕</button>
            )}
          </span>
        </label>
      )}
      {e.status === "scheduled" && (
        <>
          <label className="field">{sibs.length > 0 ? "This date" : "When"}
            <input type="datetime-local" className="input" min={MIN_DT} data-testid="edit-time"
              value={startsAt} onChange={(ev) => setStartsAt(ev.target.value)} />
          </label>
          <label className="field">Ends <span className="muted small">(optional)</span>
            <span className="row" style={{ gap: 6 }}>
              <input type="datetime-local" className="input" min={startsAt || MIN_DT} data-testid="edit-end"
                value={endsAt} onChange={(ev) => setEndsAt(ev.target.value)} />
              {endsAt !== "" && (
                <button type="button" className="btn ghost sm" style={{ flex: "none" }} data-testid="edit-end-clear"
                  onClick={() => setEndsAt("")} title="Remove the end time">✕</button>
              )}
            </span>
          </label>
        </>
      )}
      {sibs.map((occ, i) => (
        <label className="field" key={occ.id}>Date {i + 2} of the series
          <input type="datetime-local" className="input" min={MIN_DT}
            data-testid={`edit-time-sib-${i}`} value={sibValue(occ.id, occ.starts_at!)}
            onChange={(ev) => setSibTimes((m) => ({ ...m, [occ.id]: ev.target.value }))} />
        </label>
      ))}
      {/* Grow the series after the fact: each added date becomes a sibling
          occurrence with the same content and everyone carried over (a lone
          event turns into a series). */}
      {e.status === "scheduled" && (
        <>
          {addStarts.map((d, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input type="datetime-local" className="input" min={MIN_DT} data-testid={`edit-add-date-${i}`}
                value={d} onChange={(ev) => setAddStarts((m) => m.map((x, j) => (j === i ? ev.target.value : x)))} />
              <button type="button" className="btn ghost sm" data-testid={`edit-add-date-remove-${i}`}
                onClick={() => setAddStarts((m) => m.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }}
            data-testid="edit-add-date" onClick={() => setAddStarts((m) => [...m, ""])}>
            + Add another date
          </button>
          {addStarts.length > 0 && (
            <p className="muted small">New dates join this event as one series - everyone on it is carried over and RSVPs per date.</p>
          )}
        </>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className={locMode === "host_place" ? "btn sm" : "btn ghost sm"}
          data-testid="edit-loc-host" onClick={() => setLocMode("host_place")}>Set an address</button>
        <button type="button" className={locMode === "virtual" ? "btn sm" : "btn ghost sm"}
          data-testid="edit-loc-virtual" onClick={() => setLocMode("virtual")}>💻 Online</button>
        <button type="button" className={locMode === "find_venue" ? "btn sm" : "btn ghost sm"}
          data-testid="edit-loc-venue" onClick={() => setLocMode("find_venue")}>Set location later</button>
      </div>
      {locMode === "host_place" && (
        <AddressInput value={locAddr} onChange={setLocAddr} placeholder="Start typing an address…" testid="edit-address" />
      )}
      {locMode === "virtual" && (
        <input className="input" maxLength={300} data-testid="edit-meeting-url" value={locAddr} inputMode="url"
          placeholder="https://zoom.us/j/… or https://meet.google.com/…"
          onChange={(ev) => setLocAddr(ev.target.value)} />
      )}
      {/* Visibility/topic/city controls removed with Discover (App.tsx TABS
          note) - the API keeps them and save re-sends the CURRENT values, so
          existing public events keep their settings untouched. */}
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
  async function toDrafts() {
    await sendJSON(api, "POST", `/api/events/${e.id}/draft`, { draft: true });
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
        <span className="row" style={{ gap: 6, flex: "none" }}>
          {e.status !== "draft" && e.status !== "cancelled" && (
            <button className="btn ghost sm" data-testid="draft-park" onClick={toDrafts}
              title="Hide from guests and pause all emails - nothing is deleted">
              📝 Move to drafts
            </button>
          )}
          <button className="btn soft sm" data-testid="toggle-comments" onClick={toggleComments}>
            {e.comments_enabled ? "Turn off" : "Turn on"}
          </button>
        </span>
      </div>

      <div className="section-h">Cohosts</div>
      <p className="muted small" style={{ margin: 0 }}>Cohosts can edit the event, share the invite, and moderate comments.</p>
      {data.cohosts.map((c) => (
        <div key={c.user_id} className="row between" data-testid="cohost">
          <span>{c.display_name || c.handle} <span className="muted small">@{c.handle}</span></span>
          <ConfirmButton label="Remove" confirmLabel="Tap again to remove" testid={`cohost-remove-${c.handle}`}
            onConfirm={() => removeCohost(c.user_id)} />
        </div>
      ))}
      <form className="row" onSubmit={addCohost}>
        <input className="input" maxLength={40} data-testid="cohost-handle" value={handle} onChange={(ev) => setHandle(ev.target.value)} placeholder="friend's handle" />
        <button className="btn sm" data-testid="cohost-add">Add cohost</button>
      </form>
      {msg && <p className="muted small">{msg}</p>}

      <div className="section-h">Danger zone</div>
      <div className="row wrap">
        <ConfirmButton label="Cancel event" confirmLabel="Tap again - guests will see it as cancelled" testid="cancel-event"
          onConfirm={async () => { await api(`/api/events/${e.id}`, { method: "DELETE" }); reload(); }} />
        {e.series_id && (
          <ConfirmButton label="Cancel whole series" confirmLabel="Tap again - cancels EVERY date" testid="cancel-series"
            onConfirm={async () => { await api(`/api/events/${e.id}?series=all`, { method: "DELETE" }); reload(); }} />
        )}
      </div>
    </div>
  );
}

// The comment thread - visible to everyone; composer shows when comments are on.
function EventComments({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const e = data.event;
  const [body, setBody] = useState("");
  const [gif, setGif] = useState("");      // a picked Klipy gif OR an uploaded photo riding on the next post
  const [picking, setPicking] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

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
      <div className="row" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Comments</h3>
        {data.comments.length > 0 && <span className="pill polling" style={{ padding: "2px 8px" }}>{data.comments.length}</span>}
      </div>
      {data.comments.length === 0 && <p className="muted small">Nothing here yet - say hi 👋</p>}
      {data.comments.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          {data.comments.map((c, i) => {
            const own = c.user_id === data.viewer_id;
            return (
              <div key={c.id} className="comment-row" data-testid="comment">
                <Avatar url={c.avatar_url} name={c.display_name} size={30} />
                <div className={`comment-bubble ${own ? "own" : ""}`}>
                  <div className="comment-meta">
                    <strong>{own ? "You" : c.display_name || "Someone"}</strong>
                    <span className="muted" title={new Date(c.created_at).toLocaleString()}>{timeAgo(c.created_at)}</span>
                    {(own || data.can_manage) && (
                      <span style={{ marginLeft: "auto" }}>
                        <ConfirmButton label="✕" confirmLabel="Delete?" testid={`comment-delete-${i}`}
                          onConfirm={() => del(c.id)} />
                      </span>
                    )}
                  </div>
                  {c.body && <div className="comment-body"><Linkify text={c.body} /></div>}
                  {c.gif_url && <img className="comment-gif" data-testid="comment-gif" src={c.gif_url} alt="gif" loading="lazy" />}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {e.comments_enabled ? (
        <div className="stack" style={{ gap: 6 }}>
          {gif && (
            <span className="row" style={{ gap: 6 }}>
              <img className="comment-gif" data-testid="comment-gif-preview" src={gif} alt="chosen gif" />
              <button type="button" className="btn ghost sm" onClick={() => setGif("")}>✕</button>
            </span>
          )}
          <div className="row">
            <input className="input" maxLength={2000} data-testid="comment-input" value={body} placeholder="Say something…"
              onChange={(ev) => setBody(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && post()} />
            <button type="button" className="btn ghost sm" data-testid="comment-gif-open"
              onClick={() => setPicking((p) => !p)}>GIF</button>
            <button type="button" className="btn ghost sm" data-testid="comment-photo-open"
              onClick={() => photoRef.current?.click()} title="Attach a photo">📷</button>
            <input ref={photoRef} type="file" accept="image/*" data-testid="comment-photo-file"
              style={{ display: "none" }}
              onChange={async (ev) => {
                const f = ev.target.files?.[0];
                ev.target.value = "";
                if (!f) return;
                try { setGif(await fileToPhoto(f)); setPicking(false); } catch { /* unreadable image */ }
              }} />
            <button className="btn sm" data-testid="comment-post" onClick={post} disabled={!body.trim() && !gif}>Post</button>
          </div>
          {picking && <GifPicker onPick={(url) => { setGif(url); setPicking(false); }} />}
        </div>
      ) : (
        <p className="muted small" data-testid="comments-off">Comments are turned off for this event.</p>
      )}
    </div>
  );
}

// The live theme accent (the .event-theme wrapper overrides --accent) so the
// QR matches the event's look; empty = brand default.
function pageAccent(): string {
  const el = document.querySelector(".event-theme");
  return el ? getComputedStyle(el).getPropertyValue("--accent").trim() : "";
}

function ShareLink({ eventId, title }: { eventId: string; title?: string }) {
  const url = `${location.origin}/e/${eventId}`;
  const [copied, setCopied] = useState(false);
  // Invites live in group chats - prefilled deep-links beat copy-paste there.
  const msg = encodeURIComponent(`You're invited${title ? ` to ${title}` : ""} - RSVP here: ${url}`);
  return (
    <div className="card stack">
      <h3>Invite people</h3>
      <p className="muted small">Share this link - anyone who opens it can RSVP.</p>
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
        {/* Theme-matched QR for the in-person moment: hold your phone up,
            everyone scans, they land on RSVP. */}
        <QRButton url={url} accent={pageAccent()} />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <a className="accent small" data-testid="share-whatsapp" target="_blank" rel="noopener noreferrer"
          href={`https://wa.me/?text=${msg}`}
          onClick={() => analytics.capture(EVENTS.shareLinkCopied, { via: "whatsapp" })}>WhatsApp ↗</a>
        <a className="accent small" data-testid="share-sms"
          href={`sms:?&body=${msg}`}
          onClick={() => analytics.capture(EVENTS.shareLinkCopied, { via: "sms" })}>Text message ↗</a>
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
  // viewer) - the "it just knows" ranking.
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
                {fmtDateTime(o.starts_at, data.event.timezone)}
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
    const v = data.voters?.find((x) => x.user_id === uid);
    const a = data.attendees.find((x) => x.user_id === uid);
    return { id: uid, name: v?.display_name || a?.display_name || "Guest", avatar: v?.avatar_url || a?.avatar_url || null };
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

  // dates scope: the actual-time grid over the host's chosen days.
  const timeslotCounts = countBy("timeslot");
  const timeslotTop = Math.max(1, ...timeslotCounts.values());
  const grid = data.time_grid;

  // month scope: ranked days.
  const dayCounts = countBy("day");
  const days = [...dayCounts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const dayTop = Math.max(1, ...dayCounts.values());
  const dayLabel = (v: string) => {
    const [y, mo, d] = v.split("-").map(Number);
    return new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  // Multi-date finalize: the host TAPS winning cells right on the results (or
  // types times manually) - one or several. Extra dates become a series with
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
  // General-scope cells aren't dated - the host first picks a TARGET MONTH
  // (the group's month votes, best-first; "Soonest" = next occurrence), then a
  // weekday cell resolves to that month's first future matching date.
  const [targetMonth, setTargetMonth] = useState<string>("");
  const monthChoices: { value: string; label: string }[] = (() => {
    const voted = [...monthCounts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    const opts = voted.length > 0 ? voted : nextMonths(6).map((m) => m.value);
    return opts.map((v) => {
      const [y, mo] = v.split("-").map(Number);
      return { value: v, label: new Date(y, mo - 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }) };
    });
  })();
  // Tapping a weekday cell EXPANDS its concrete dates ("every Tuesday of
  // August") - the host picks the 1st, 3rd, all of them, whatever. One cell
  // open at a time.
  const [instCell, setInstCell] = useState<{ wd: number; dp: string } | null>(null);
  const fmtYMD = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Every future date of that weekday inside the target month, or the next 4
  // occurrences from today when scheduling into "Soonest".
  const weekdayInstances = (wd: number): string[] => {
    const out: string[] = [];
    if (targetMonth) {
      const [y, mo] = targetMonth.split("-").map(Number);
      const d = new Date(y, mo - 1, 1);
      while (d.getDay() !== wd) d.setDate(d.getDate() + 1);
      for (; d.getMonth() === mo - 1; d.setDate(d.getDate() + 7)) {
        if (d.getTime() >= Date.now() - 86_400_000) out.push(fmtYMD(d));
      }
      return out;
    }
    const d = new Date();
    do { d.setDate(d.getDate() + 1); } while (d.getDay() !== wd);
    for (let i = 0; i < 4; i++) {
      out.push(fmtYMD(d));
      d.setDate(d.getDate() + 7);
    }
    return out;
  };
  const instKey = (wd: number, dp: string, date: string) => `inst|${wd}:${dp}|${date}`;
  const cellHasInstPicks = (wd: number, dp: string) =>
    [...picked.keys()].some((k) => k.startsWith(`inst|${wd}:${dp}|`));
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
    <div className="card stack" data-testid="general-results">
      <div className="row between"><h3>Group availability</h3><span className="muted small">{voters} responded</span></div>

      {scope === "week" && (
        <div>
          <div className="section-h" style={{ margin: "0 0 4px" }}>Best times this week</div>
          {dayslotCounts.size === 0 ? <p className="muted small">No picks yet.</p> : (
            <div className="grid" style={{ gridTemplateColumns: `auto repeat(${DAYPARTS.length}, 1fr)` }} data-testid="gr-week-heat">
              <div />
              {DAYPARTS.map((dp) => <div key={dp.value} className="hd">{dp.short}</div>)}
              {weekDates.filter((d) => dayslotCounts.size === 0 || DAYPARTS.some((dp) => (dayslotCounts.get(`${d.value}:${dp.value}`) ?? 0) > 0)).map((d) => (
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

      {scope === "dates" && grid && (
        <div>
          <div className="section-h" style={{ margin: "0 0 4px" }}>Best times{canPick ? " · tap a cell to lock it in" : ""}</div>
          {timeslotCounts.size === 0 ? <p className="muted small">No picks yet.</p> : (
            <TimeGrid days={(data.poll_days || []).map(dayCol)} slots={gridSlots(grid.start_min, grid.end_min, grid.slot_min)}
              free={new Set()} counts={timeslotCounts} top={timeslotTop} fmtSlot={fmtMinutes}
              pick={new Set([...picked.keys()])} idPrefix="grt" testid="gr-time-heat"
              onCellClick={canPick ? (day, m) => togglePick(`${day}:${m}`,
                `${day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`) : undefined} />
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
              {monthDates28.filter((d) => dayslotCounts.size === 0 || DAYPARTS.some((dp) => (dayslotCounts.get(`${d.value}:${dp.value}`) ?? 0) > 0)).map((d) => (
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
            {canPick && (
              <div className="row wrap" style={{ gap: 6, marginBottom: 6 }} data-testid="target-month-row">
                <span className="muted small">Schedule into:</span>
                <button type="button" className={`chip sm ${targetMonth === "" ? "on" : ""}`}
                  data-testid="target-month-soon" onClick={() => setTargetMonth("")}>Soonest</button>
                {monthChoices.map((m) => (
                  <button key={m.value} type="button" className={`chip sm ${targetMonth === m.value ? "on" : ""}`}
                    data-testid={`target-month-${m.value}`} onClick={() => setTargetMonth(m.value)}>{m.label}</button>
                ))}
              </div>
            )}
            <div className="grid" style={{ gridTemplateColumns: `auto repeat(${DAYPARTS.length}, 1fr)` }}>
              <div />
              {DAYPARTS.map((dp) => <div key={dp.value} className="hd">{dp.short}</div>)}
              {WEEKDAYS.map((d, wd) => ({ d, wd })).filter(({ wd }) => slotCounts.size === 0 || DAYPARTS.some((dp) => (slotCounts.get(slotKey(wd, dp.value)) ?? 0) > 0)).map(({ d, wd }) => (
                <Fragment key={wd}>
                  <div className="day" style={{ textAlign: "left" }}>{d}</div>
                  {DAYPARTS.map((dp) => {
                    const key = slotKey(wd, dp.value);
                    const n = slotCounts.get(key) ?? 0;
                    const open = instCell?.wd === wd && instCell?.dp === dp.value;
                    const hasPicks = cellHasInstPicks(wd, dp.value);
                    return (
                      <button key={dp.value} type="button" className="cell" data-testid={`grg-pick-${wd}-${dp.value}`}
                        onClick={() => { if (canPick) setInstCell(open ? null : { wd, dp: dp.value }); }}
                        style={{ ...heatStyle(n, slotTop), ...pickedStyle(key), ...(hasPicks || open ? { outline: "3px solid var(--accent)", outlineOffset: "-3px", position: "relative", zIndex: 2, opacity: open ? 1 : undefined } : {}), display: "grid", placeItems: "center", fontSize: "0.8rem", fontWeight: 700, cursor: canPick ? "pointer" : "default" }}>
                        {n > 0 ? n : ""}
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </div>
            {instCell && (() => {
              const dates = weekdayInstances(instCell.wd);
              const hour = String(DAYPART_HOUR[instCell.dp]).padStart(2, "0");
              const dpLabel = DAYPARTS.find((x) => x.value === instCell.dp)?.short ?? instCell.dp;
              const keys = dates.map((date) => instKey(instCell.wd, instCell.dp, date));
              const allOn = dates.length > 0 && keys.every((k) => picked.has(k));
              return (
                <div className="row wrap" style={{ gap: 6, marginTop: 8 }} data-testid="inst-row">
                  <span className="muted small">{WEEKDAYS[instCell.wd]} · {dpLabel}:</span>
                  {dates.length === 0 && <span className="muted small">no dates left in that month</span>}
                  {dates.map((date, i) => (
                    <button key={date} type="button" className={`chip sm ${picked.has(keys[i]) ? "on" : ""}`}
                      data-testid={`inst-${date}`}
                      onClick={() => togglePick(keys[i], `${date}T${hour}:00`)}>
                      {new Date(`${date}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </button>
                  ))}
                  {dates.length > 1 && (
                    <button type="button" className="chip sm" data-testid="inst-all"
                      onClick={() => setPicked((m) => {
                        const next = new Map(m);
                        if (allOn) keys.forEach((k) => next.delete(k));
                        else dates.forEach((date, i) => next.set(keys[i], `${date}T${hour}:00`));
                        return next;
                      })}>
                      {allOn ? "None" : "All"}
                    </button>
                  )}
                </div>
              );
            })()}
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
              ? `Highlighting ${responders.find((r) => r.id === sel)?.name}'s picks - tap again for everyone.`
              : "Tap someone to see exactly what they picked."}
          </p>
        </div>
      )}

      <div className="divider" />
      <div className="muted small">
        {canPick ? "Tap winning cells above to schedule them" : "Pick the winning date & time"}
        {canPick ? " - or type times manually:" : ":"}
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
      <div className="row" style={{ gap: 6 }}>
        <input type="datetime-local" className="input" min={MIN_DT} data-testid="general-finalize-time" value={when}
          onChange={(ev) => setWhen(ev.target.value)} />
        {when !== "" && (
          <button type="button" className="btn ghost sm" data-testid="general-finalize-clear"
            onClick={() => setWhen("")} title="Clear this time">✕</button>
        )}
      </div>
      {moreWhens.map((v, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input type="datetime-local" className="input" min={MIN_DT} data-testid={`general-finalize-time-${i + 1}`} value={v}
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
        <p className="muted small">All {pickCount} dates become one series - everyone here is on each date, RSVPs carried over.</p>
      )}
    </div>
  );
}

// Who's coming - grouped by RSVP so it's scannable at a glance. Any real
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
  // Guests have no account to befriend from - they still see the full list.
  const viewerIsGuest = viewerId.startsWith("guest_");

  async function addFriend(handle: string) {
    setRequested((s) => new Set(s).add(handle));
    const res = await sendJSON(api, "POST", "/api/friends", { handle });
    if (!res.ok) setRequested((s) => { const n = new Set(s); n.delete(handle); return n; });
    else reload();
  }

  const GROUPS: { key: Attendee["rsvp"]; label: string }[] = [
    { key: "going", label: "Going" },
    { key: "waitlist", label: "Waitlist" },
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
      {total === 0 && <p className="muted small">No responses yet - share the link to get RSVPs.</p>}

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
