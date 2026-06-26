import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  Attendee,
  EventDetail,
  PrefAnswer,
  TimeOption,
  Vote,
  fmtDate,
  fmtDateTime,
  getJSON,
  sendJSON,
  useApi,
} from "../lib";
import { QUESTIONS, emojiFor, labelFor, questionLabel } from "../scheduler/questions";
import { BackLink, Loading, Pill, useAsync } from "../ui";

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
          onClick={() => setPreview((p) => !p)}>
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
        <button className="btn soft sm" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); }}>
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
