import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  Attendee,
  DAYPARTS,
  EventDetail,
  GeneralVote,
  PrefAnswer,
  TimeOption,
  Vote,
  WEEKDAYS,
  fmtDate,
  fmtDateTime,
  getJSON,
  nextMonths,
  sendJSON,
  useApi,
} from "../lib";
import { QUESTIONS, emojiFor, labelFor, questionLabel } from "../scheduler/questions";
import { BackLink, Loading, Pill, useAsync } from "../ui";
import { EVENTS, analytics } from "../analytics";

export function EventPage() {
  const { id } = useParams();
  const { data, loading, reload } = useAsync<EventDetail>((api) => getJSON(api, `/api/events/${id}`), [id]);
  const [preview, setPreview] = useState(false);

  if (loading) return <Loading />;
  if (!data) return <div className="stack"><BackLink /><p className="muted">Event not found.</p></div>;

  const showHost = data.role === "host" && !preview;
  const e = data.event;

  return (
    <div className="stack">
      <BackLink />
      <div className="card stack">
        <div className="row" style={{ gap: "0.9rem" }}>
          <div className="emoji" style={{ fontSize: "1.8rem", width: 56, height: 56 }}>{emojiFor(e.event_type)}</div>
          <div style={{ flex: 1 }}>
            <h1 data-testid="event-title">{e.title}</h1>
            <p className="muted">{labelFor(e.event_type)}</p>
          </div>
          {e.status === "polling" ? <Pill kind="polling">Polling</Pill> : <Pill kind="scheduled">Confirmed</Pill>}
        </div>
        {e.description && <p>{e.description}</p>}
        <div className="muted small">
          🗓️ {e.status === "polling" ? "Time being decided" : fmtDate(e.starts_at)}
          {e.status !== "polling" && e.starts_at ? ` · ${fmtDateTime(e.starts_at).split(", ").pop()}` : ""}
        </div>
        <div className="muted small">
          {e.location_mode === "find_venue" ? "📍 Venue to be decided" : `📍 ${e.location_address || "At the host's place"}`}
        </div>
      </div>

      {showHost ? <HostView data={data} reload={reload} /> : <GuestView data={data} reload={reload} />}

      {data.role === "host" && (
        <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} data-testid="preview-toggle"
          onClick={() => setPreview((p) => { analytics.capture(EVENTS.previewToggled, { to: !p ? "guest" : "host" }); return !p; })}>
          {preview ? "← Back to host view" : "👀 Preview as guest"}
        </button>
      )}
    </div>
  );
}

// ---------------- guest / invitee experience ----------------

function GuestView({ data, reload }: { data: EventDetail; reload: () => void }) {
  const e = data.event;
  const myRsvp = data.attendees.find((a) => a.user_id === data.viewer_id)?.rsvp;
  return (
    <div className="stack">
      <Rsvp eventId={e.id} current={myRsvp} reload={reload} />
      {e.scheduling_mode === "poll" && e.status === "polling" && (
        <PollVote eventId={e.id} options={data.time_options} votes={data.votes} viewerId={data.viewer_id} reload={reload} />
      )}
      {e.scheduling_mode === "general" && e.status === "polling" && (
        <GeneralPoll eventId={e.id} votes={data.general_votes} viewerId={data.viewer_id} reload={reload} />
      )}
      <PrefFlow eventId={e.id} type={e.event_type} answers={data.preference_answers.filter((a) => a.user_id === data.viewer_id)} reload={reload} />
    </div>
  );
}

function Rsvp({ eventId, current, reload }: { eventId: string; current?: string; reload: () => void }) {
  const api = useApi();
  async function set(rsvp: string) {
    await sendJSON(api, "POST", `/api/events/${eventId}/rsvp`, { rsvp });
    reload();
  }
  const opts: [string, string][] = [["going", "✅ Going"], ["maybe", "🤔 Maybe"], ["declined", "✕ Can't"]];
  return (
    <div className="card stack">
      <h3>Are you in?</h3>
      <div className="row wrap">
        {opts.map(([v, label]) => (
          <button key={v} className={`chip ${current === v ? "on" : ""}`} data-testid={`rsvp-${v}`} onClick={() => set(v)}>
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
          <span className="small">{fmtDateTime(o.starts_at)}</span>
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

// General-availability poll: the guest picks ideal months, weekdays, and times
// of day. The whole set is saved at once (replace semantics on the API).
function GeneralPoll({ eventId, votes, viewerId, reload }: {
  eventId: string; votes: GeneralVote[]; viewerId: string; reload: () => void;
}) {
  const api = useApi();
  const months = nextMonths(6);
  const mine = votes.filter((v) => v.user_id === viewerId);
  const pick = (dim: GeneralVote["dimension"]) =>
    new Set(mine.filter((v) => v.dimension === dim).map((v) => v.value));

  const [sel, setSel] = useState<Record<string, Set<string>>>({
    month: pick("month"),
    weekday: pick("weekday"),
    daypart: pick("daypart"),
  });
  const [saved, setSaved] = useState(false);

  function toggle(dim: string, value: string) {
    setSaved(false);
    setSel((s) => {
      const next = new Set(s[dim]);
      next.has(value) ? next.delete(value) : next.add(value);
      return { ...s, [dim]: next };
    });
  }

  async function save() {
    await sendJSON(api, "POST", `/api/events/${eventId}/general-votes`, {
      months: [...sel.month],
      weekdays: [...sel.weekday].map(Number),
      dayparts: [...sel.daypart],
    });
    setSaved(true);
    reload();
  }

  return (
    <div className="card stack">
      <h3>When works for you?</h3>
      <div>
        <div className="muted small" style={{ marginBottom: 6 }}>Ideal months</div>
        <div className="row wrap">
          {months.map((m, i) => (
            <button key={m.value} className={`chip sm ${sel.month.has(m.value) ? "on" : ""}`}
              data-testid={`gp-month-${i}`} onClick={() => toggle("month", m.value)}>{m.label}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="muted small" style={{ marginBottom: 6 }}>Days that work</div>
        <div className="row wrap">
          {WEEKDAYS.map((d, wd) => (
            <button key={wd} className={`chip sm ${sel.weekday.has(String(wd)) ? "on" : ""}`}
              data-testid={`gp-weekday-${wd}`} onClick={() => toggle("weekday", String(wd))}>{d}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="muted small" style={{ marginBottom: 6 }}>Times of day</div>
        <div className="row wrap">
          {DAYPARTS.map((dp) => (
            <button key={dp.value} className={`chip sm ${sel.daypart.has(dp.value) ? "on" : ""}`}
              data-testid={`gp-daypart-${dp.value}`} onClick={() => toggle("daypart", dp.value)}>{dp.label}</button>
          ))}
        </div>
      </div>
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
      {e.scheduling_mode === "poll" && e.status === "polling" && (
        <PollResults data={data} reload={reload} />
      )}
      {e.scheduling_mode === "general" && e.status === "polling" && (
        <GeneralResults data={data} reload={reload} />
      )}
      <Guests attendees={data.attendees} />
      <AnswerSummary data={data} />
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
      </div>
    </div>
  );
}

function PollResults({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const voters = new Set(data.votes.map((v) => v.user_id)).size || 1;
  async function finalize(o: TimeOption) {
    await sendJSON(api, "POST", `/api/events/${data.event.id}/finalize`, { starts_at: o.starts_at });
    reload();
  }
  return (
    <div className="card stack">
      <h3>Availability</h3>
      {data.time_options.map((o) => {
        const yes = data.votes.filter((v) => v.option_id === o.id && v.response === "yes").length;
        return (
          <div key={o.id} className="stack" style={{ gap: 4 }}>
            <div className="row between">
              <span className="small">{fmtDateTime(o.starts_at)}</span>
              <div className="row">
                <span className="muted small">{yes} available</span>
                <button className="btn sm" data-testid={`finalize-${o.id}`} onClick={() => finalize(o)}>Pick</button>
              </div>
            </div>
            <div className="tally"><span style={{ width: `${(yes / voters) * 100}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}

// Aggregates the general poll (months / weekdays / dayparts) and lets the host
// read the group's preference, then finalize a concrete time.
function GeneralResults({ data, reload }: { data: EventDetail; reload: () => void }) {
  const api = useApi();
  const [when, setWhen] = useState("");

  const voters = new Set(data.general_votes.map((v) => v.user_id)).size;
  const counts = (dim: GeneralVote["dimension"]) => {
    const m = new Map<string, number>();
    data.general_votes.filter((v) => v.dimension === dim).forEach((v) => m.set(v.value, (m.get(v.value) ?? 0) + 1));
    return m;
  };
  const monthLabel = (v: string) => {
    const [y, mo] = v.split("-").map(Number);
    return new Date(y, mo - 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };
  const dayName = (v: string) => WEEKDAYS[Number(v)] ?? v;
  const daypartLabel = (v: string) => DAYPARTS.find((d) => d.value === v)?.label ?? v;

  const ranked = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const max = (m: Map<string, number>) => Math.max(1, ...m.values());

  function Bars({ dim, label }: { dim: GeneralVote["dimension"]; label: (v: string) => string }) {
    const m = counts(dim);
    const top = max(m);
    const rows = ranked(m);
    if (rows.length === 0) return <p className="muted small">No picks yet.</p>;
    return (
      <div className="stack" style={{ gap: 4 }}>
        {rows.map(([value, n]) => (
          <div key={value} className="stack" style={{ gap: 2 }}>
            <div className="row between"><span className="small">{label(value)}</span><span className="muted small">{n}</span></div>
            <div className="tally"><span style={{ width: `${(n / top) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    );
  }

  async function finalize() {
    if (!when) return;
    await sendJSON(api, "POST", `/api/events/${data.event.id}/finalize`, { starts_at: new Date(when).toISOString() });
    reload();
  }

  return (
    <div className="card stack">
      <div className="row between"><h3>Group availability</h3><span className="muted small">{voters} responded</span></div>
      <div><div className="section-h" style={{ margin: "0 0 4px" }}>Months</div><Bars dim="month" label={monthLabel} /></div>
      <div><div className="section-h" style={{ margin: "0 0 4px" }}>Days</div><Bars dim="weekday" label={dayName} /></div>
      <div><div className="section-h" style={{ margin: "0 0 4px" }}>Times of day</div><Bars dim="daypart" label={daypartLabel} /></div>
      <div className="divider" />
      <div className="muted small">Pick the final date &amp; time:</div>
      <div className="row">
        <input type="datetime-local" className="input" data-testid="general-finalize-time" value={when}
          onChange={(ev) => setWhen(ev.target.value)} />
        <button className="btn sm" data-testid="general-finalize" disabled={!when} onClick={finalize}>Finalize</button>
      </div>
    </div>
  );
}

function Guests({ attendees }: { attendees: Attendee[] }) {
  const going = attendees.filter((a) => a.rsvp === "going").length;
  return (
    <div className="card stack">
      <div className="row between"><h3>Guests</h3><span className="muted small">{going} going</span></div>
      {attendees.length === 0 && <p className="muted small">No responses yet.</p>}
      {attendees.map((a) => (
        <div key={a.user_id} className="row between">
          <span>{a.display_name || "Someone"}</span>
          <Pill kind={a.rsvp}>{a.rsvp}</Pill>
        </div>
      ))}
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
