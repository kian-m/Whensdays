import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Event, EventType, getJSON, hostTimezone, sendJSON, toDatetimeLocal, useApi } from "../lib";
import { EVENT_TYPES } from "../scheduler/questions";
import { AddressInput, useAsync } from "../ui";
import { DEV_AUTH } from "../App";
import { EVENTS, analytics } from "../analytics";

// Native min-validation would block dev/E2E backdating - server enforces the
// same rule with the same dev exemption.
const MIN_DT = DEV_AUTH ? undefined : toDatetimeLocal(new Date().toISOString());

// Event creation is TWO screens, not a 4-step wizard. Screen 1 ("Start") holds
// the three decisions that matter - title, type, and how you'll schedule - and
// fits on a phone without scrolling. Screen 2 ("Add details") is fully optional
// (location, capacity) and reached only by a plain text link. Cover/theme/
// description/friend-invites all moved to edit-in-place on the created event.

// The five most common types get plain chips on Screen 1; every other preset,
// the user's saved custom types, and a "name a new one" box live behind "More".
const PRIMARY_TYPES: EventType[] = ["practice", "show", "party", "dinner", "drinks"];
// Custom types get a SYSTEM icon automatically - there is no emoji picker. A
// generic calendar covers any type the user names themselves.
const CUSTOM_TYPE_ICON = "🗓️";

export function NewEvent() {
  const api = useApi();
  const nav = useNavigate();
  // Arriving from a group page (?group=<id>) attaches the event to that group.
  const [params] = useSearchParams();
  const groupId = params.get("group") || "";
  // "Plan the next one" (?again=<eventId>, from the recap email / a past event):
  // prefill from that event so re-hosting is a couple of taps.
  const againId = params.get("again") || "";
  // Re-poll (?repoll=1): default to a time poll and re-invite everyone from the
  // source event on create.
  const repoll = params.get("repoll") === "1" && !!againId;

  useEffect(() => {
    analytics.capture(EVENTS.createEventOpened, againId ? { again: true } : undefined);
  }, []);

  const [screen, setScreen] = useState<"start" | "details">("start");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<EventType>("practice");
  // Custom type: a name + a system-assigned icon (never user-picked). Present =
  // the event is stored as `other` with this label/emoji.
  const [custom, setCustom] = useState<{ emoji: string; label: string } | null>(null);
  // Description is no longer entered at creation, but a re-host prefill carries
  // the old one through silently so re-posting doesn't lose it (edited later on
  // the event page).
  const [description, setDescription] = useState("");
  const [locationMode, setLocationMode] = useState<"host_place" | "find_venue" | "virtual">("host_place");
  const [address, setAddress] = useState("");
  // Poll-a-few-times is the default: it's the group-scheduling wedge.
  const [schedulingMode, setSchedulingMode] = useState<"fixed" | "poll" | "general">("poll");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [repeat, setRepeat] = useState<"" | "weekly" | "biweekly" | "monthly">("");
  const [repeatCount, setRepeatCount] = useState(4);
  const [moreStarts, setMoreStarts] = useState<string[]>([]);
  const [showRepeat, setShowRepeat] = useState(false); // "+ Repeat or add more dates" (fixed)
  const [pollDeadline, setPollDeadline] = useState("");
  const [showDeadline, setShowDeadline] = useState(false); // "+ Set a poll deadline" (poll)
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [capacity, setCapacity] = useState("");
  const [typeSheet, setTypeSheet] = useState(false); // "More" type bottom sheet
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: ct, reload: reloadTypes } = useAsync<{ types: { label: string; emoji: string }[] }>((a) => getJSON(a, "/api/event-types"));
  const savedTypes = ct?.types ?? [];
  // Group context (name) when launched from a group page - implicit, read-only.
  const { data: grp } = useAsync<{ name: string; emoji: string }>(
    (a) => (groupId ? getJSON(a, `/api/groups/${groupId}/preview`) : Promise.resolve({ name: "", emoji: "" })), [groupId]);

  useEffect(() => {
    if (!againId) return;
    getJSON<{ event: { title: string; event_type: EventType; description: string; location_mode: "host_place" | "find_venue" | "virtual"; location_address: string; custom_emoji: string; custom_label: string } }>(
      api, `/api/events/${againId}`,
    ).then((d) => {
      if (repoll) setSchedulingMode("poll");
      setTitle(d.event.title);
      setType(d.event.event_type);
      setDescription(d.event.description);
      setLocationMode(d.event.location_mode);
      setAddress(d.event.location_address);
      if (d.event.custom_label) setCustom({ emoji: d.event.custom_emoji || CUSTOM_TYPE_ICON, label: d.event.custom_label });
    }).catch(() => { /* stale link - start blank */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [againId]);

  function setOption(i: number, v: string) {
    setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  }
  function pickPreset(v: EventType) { setType(v); setCustom(null); }
  function pickSaved(t: { emoji: string; label: string }) { setType("other"); setCustom({ emoji: t.emoji, label: t.label }); }

  const startValid = title.trim() !== "" &&
    (schedulingMode === "fixed" ? startsAt !== ""
      : schedulingMode === "poll" ? options.some((o) => o.trim() !== "")
        : true); // general: no time chosen at creation - host sets up the poll after

  async function submit() {
    setError(null);
    if (!DEV_AUTH) {
      const chosen = schedulingMode === "fixed" ? [startsAt, ...moreStarts] : schedulingMode === "poll" ? options : [];
      if (chosen.some((v) => v.trim() !== "" && new Date(v).getTime() < Date.now() - 3600_000)) {
        return setError("Events can't start in the past - pick an upcoming time.");
      }
    }
    setSaving(true);
    const body: Record<string, unknown> = {
      title,
      event_type: type,
      description,
      location_mode: locationMode,
      location_address: locationMode === "find_venue" ? "" : address.trim(),
      scheduling_mode: schedulingMode,
      timezone: hostTimezone(),
    };
    if (groupId) body.group_id = groupId;
    if (repoll) body.invite_from = againId;
    if (custom) {
      body.custom_emoji = custom.emoji;
      body.custom_label = custom.label;
    }
    // Events start invite-only; the host opens them up later from the event page.
    body.visibility = "private";
    if (schedulingMode === "fixed") {
      body.starts_at = startsAt ? new Date(startsAt).toISOString() : "";
      if (endsAt) body.ends_at = new Date(endsAt).toISOString();
      if (repeat) {
        body.repeat = repeat;
        body.repeat_count = repeatCount;
      }
      const extras = moreStarts.filter((d) => d.trim() !== "");
      if (extras.length > 0) body.more_starts = extras.map((d) => new Date(d).toISOString());
    } else if (schedulingMode === "poll") {
      body.time_options = options
        .filter((o) => o.trim() !== "")
        .map((o) => new Date(o).toISOString());
    }
    // A general poll is created WITHOUT a scope - the host completes that setup
    // step (this week / this month / generally / pick days) on the event page.
    if (schedulingMode !== "fixed" && pollDeadline) body.poll_deadline = new Date(pollDeadline).toISOString();
    if (capacity.trim() !== "") body.capacity = Number(capacity);
    const res = await sendJSON(api, "POST", "/api/events", body);
    if (!res.ok) {
      setSaving(false);
      const b = await res.json().catch(() => ({}));
      return setError(b.error || "could not create event");
    }
    const ev: Event = await res.json();
    // First event ever on this device -> suggest add-to-homescreen once.
    try {
      if (!localStorage.getItem("whensdays.a2hs")) sessionStorage.setItem("whensdays.a2hs-pending", "1");
    } catch { /* private mode */ }
    nav(`/e/${ev.id}`);
  }

  const typeLabel = custom ? `${custom.emoji} ${custom.label}` : (() => {
    const et = EVENT_TYPES.find((e) => e.value === type);
    return et ? `${et.emoji} ${et.label}` : "";
  })();
  // Types offered inside the "More" sheet = every preset not on the primary row.
  const moreTypes = EVENT_TYPES.filter((et) => !PRIMARY_TYPES.includes(et.value));

  return (
    <div className="stack">
      <div className="row between">
        <h1>{screen === "start" ? "New event" : "Add details"}</h1>
        {grp?.name && screen === "start" && (
          <span className="muted small" data-testid="wiz-group">{grp.emoji} {grp.name}</span>
        )}
      </div>

      <form className="card stack" onSubmit={(e) => e.preventDefault()}>
        {screen === "start" && (
          <>
            <div>
              <label className="field" htmlFor="t">What's the plan?</label>
              <input id="t" className="input" maxLength={140} data-testid="event-title" value={title}
                onChange={(e) => setTitle(e.target.value)} placeholder="Friday rehearsal" autoFocus />
            </div>

            <div>
              <label className="field">Type</label>
              <div className="row wrap" style={{ gap: 6, alignItems: "center" }}>
                {PRIMARY_TYPES.map((v) => {
                  const et = EVENT_TYPES.find((e) => e.value === v)!;
                  return (
                    <button type="button" key={v} className={`chip ${type === v && !custom ? "on" : ""}`}
                      data-testid={`type-${v}`} onClick={() => pickPreset(v)}>
                      {et.emoji} {et.label}
                    </button>
                  );
                })}
                {/* A chosen type that isn't a primary chip (a preset from "More"
                    or a custom type) shows as one extra selected chip. */}
                {((custom) || (!PRIMARY_TYPES.includes(type) && !custom)) && (
                  <button type="button" className="chip on" data-testid="type-chosen"
                    onClick={() => setTypeSheet(true)}>{typeLabel}</button>
                )}
                <button type="button" className="linklike" data-testid="type-more"
                  onClick={() => setTypeSheet(true)}>More…</button>
              </div>
            </div>

            <div>
              <label className="field">When</label>
              <div className="segmented" role="group" aria-label="How to schedule">
                <button type="button" className={schedulingMode === "fixed" ? "on" : ""}
                  data-testid="sched-fixed" aria-pressed={schedulingMode === "fixed"}
                  onClick={() => setSchedulingMode("fixed")}>Pick a time</button>
                <button type="button" className={schedulingMode === "poll" ? "on" : ""}
                  data-testid="sched-poll" aria-pressed={schedulingMode === "poll"}
                  onClick={() => setSchedulingMode("poll")}>Poll a few times</button>
                <button type="button" className={schedulingMode === "general" ? "on" : ""}
                  data-testid="sched-general" aria-pressed={schedulingMode === "general"}
                  onClick={() => setSchedulingMode("general")}>Not sure yet</button>
              </div>

              {schedulingMode === "fixed" && (
                <div className="stack" style={{ marginTop: 8 }}>
                  <input type="datetime-local" className="input" min={MIN_DT}
                    data-testid="fixed-time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                  {!showRepeat ? (
                    <button type="button" className="linklike" data-testid="show-repeat"
                      onClick={() => setShowRepeat(true)}>+ Repeat or add more dates</button>
                  ) : (
                    <div className="stack" style={{ gap: 6 }}>
                      <label className="field" style={{ marginBottom: 0 }}>Ends <span className="muted small">(optional)</span>
                        <span className="row" style={{ gap: 6 }}>
                          <input type="datetime-local" className="input" min={startsAt || MIN_DT}
                            data-testid="fixed-end" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                          {endsAt !== "" && (
                            <button type="button" className="btn ghost sm" style={{ flex: "none" }} data-testid="fixed-end-clear"
                              onClick={() => setEndsAt("")} title="Remove the end time">✕</button>
                          )}
                        </span>
                      </label>
                      {moreStarts.map((d, i) => (
                        <div key={i} className="row" style={{ gap: 6 }}>
                          <input type="datetime-local" className="input" min={MIN_DT} data-testid={`more-date-${i}`}
                            value={d} onChange={(e) => setMoreStarts((m) => m.map((x, j) => (j === i ? e.target.value : x)))} />
                          <button type="button" className="btn ghost sm" data-testid={`more-date-remove-${i}`}
                            onClick={() => setMoreStarts((m) => m.filter((_, j) => j !== i))}>✕</button>
                        </div>
                      ))}
                      <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }}
                        data-testid="add-date" onClick={() => { setRepeat(""); setMoreStarts((m) => [...m, ""]); }}>
                        + Add another date
                      </button>
                      {moreStarts.length === 0 && (
                        <div className="row wrap" style={{ gap: 6 }}>
                          <span className="muted small">Repeats:</span>
                          {([["", "Never"], ["weekly", "Weekly"], ["biweekly", "Every 2 weeks"], ["monthly", "Monthly"]] as const).map(([v, l]) => (
                            <button key={v} type="button" className={`chip sm ${repeat === v ? "on" : ""}`}
                              data-testid={`repeat-${v || "never"}`} onClick={() => setRepeat(v)}>{l}</button>
                          ))}
                          {repeat && (
                            <select className="input" style={{ width: "auto" }} data-testid="repeat-count"
                              value={repeatCount} onChange={(e) => setRepeatCount(Number(e.target.value))}>
                              {[2, 3, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{n} times</option>)}
                            </select>
                          )}
                        </div>
                      )}
                      {moreStarts.length > 0 && (
                        <p className="muted small" style={{ margin: 0 }}>These dates become one series - everyone RSVPs per date.</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {schedulingMode === "poll" && (
                <div className="stack" style={{ marginTop: 8 }}>
                  {options.map((o, i) => (
                    <input key={i} type="datetime-local" className="input" min={MIN_DT} data-testid={`poll-option-${i}`}
                      value={o} onChange={(e) => setOption(i, e.target.value)} />
                  ))}
                  {options.length < 4 && (
                    <button type="button" className="linklike" data-testid="add-option"
                      onClick={() => setOptions((o) => [...o, ""])}>+ Add another time</button>
                  )}
                  {!showDeadline ? (
                    <button type="button" className="linklike" data-testid="show-deadline"
                      onClick={() => setShowDeadline(true)}>+ Set a poll deadline</button>
                  ) : (
                    <label className="field" style={{ marginBottom: 0 }}>Poll closes <span className="muted small">(optional)</span>
                      <span className="row" style={{ gap: 6 }}>
                        <input type="datetime-local" className="input" min={MIN_DT} data-testid="poll-deadline"
                          value={pollDeadline} onChange={(e) => setPollDeadline(e.target.value)} />
                        {pollDeadline !== "" && (
                          <button type="button" className="btn ghost sm" style={{ flex: "none" }} data-testid="poll-deadline-clear"
                            onClick={() => setPollDeadline("")} title="Remove the close date">✕</button>
                        )}
                      </span>
                    </label>
                  )}
                </div>
              )}

              {schedulingMode === "general" && (
                <p className="muted small" style={{ marginTop: 8 }} data-testid="general-note">
                  You'll pick the dates to ask about after creating this.
                </p>
              )}
            </div>

            {error && <p className="err">{error}</p>}

            <div className="row between" style={{ alignItems: "center" }}>
              <button type="button" className="linklike" data-testid="go-details"
                onClick={() => setScreen("details")}>Where + more…</button>
              <button type="button" className="btn" data-testid="create-event"
                disabled={saving || !startValid} onClick={submit}>
                {saving ? "Creating…" : "Create"}
              </button>
            </div>
          </>
        )}

        {screen === "details" && (
          <>
            <div>
              <label className="field">Where</label>
              <div className="row wrap">
                <button type="button" className={`chip ${locationMode === "host_place" ? "on" : ""}`}
                  data-testid="loc-host" onClick={() => setLocationMode("host_place")}>📍 I’ll set the address</button>
                <button type="button" className={`chip ${locationMode === "virtual" ? "on" : ""}`}
                  data-testid="loc-virtual" onClick={() => setLocationMode("virtual")}>💻 Online</button>
                <button type="button" className={`chip ${locationMode === "find_venue" ? "on" : ""}`}
                  data-testid="loc-venue" onClick={() => setLocationMode("find_venue")}>📍 Help me find a venue</button>
              </div>
              {locationMode === "virtual" && (
                <input className="input" style={{ marginTop: 8 }} maxLength={300} data-testid="meeting-url" value={address} inputMode="url"
                  placeholder="https://zoom.us/j/… or https://meet.google.com/…"
                  onChange={(e) => setAddress(e.target.value)} />
              )}
              {locationMode === "host_place" && (
                <div style={{ marginTop: 8 }}>
                  <AddressInput value={address} onChange={setAddress} placeholder="Start typing an address…" testid="event-address" />
                </div>
              )}
              {locationMode === "find_venue" && (
                <p className="muted small" style={{ marginTop: 8 }}>We'll help pick a spot once the group is set.</p>
              )}
            </div>

            <div>
              <label className="field" htmlFor="cap">Max spots <span className="muted small">(optional - beyond it people join a waitlist)</span></label>
              <input id="cap" type="number" min={0} max={500} inputMode="numeric" className="input" data-testid="event-capacity"
                value={capacity} placeholder="Unlimited" onChange={(e) => setCapacity(e.target.value)} />
            </div>

            {error && <p className="err">{error}</p>}

            <div className="row between" style={{ alignItems: "center" }}>
              <button type="button" className="linklike" data-testid="details-back"
                onClick={() => setScreen("start")}>← Back</button>
              <button type="button" className="btn" data-testid="create-event-details"
                disabled={saving || !startValid} onClick={submit}>
                {saving ? "Creating…" : "Create"}
              </button>
            </div>
            <button type="button" className="linklike muted small" style={{ alignSelf: "center" }}
              data-testid="details-skip" onClick={submit} disabled={saving || !startValid}>Skip for now</button>
          </>
        )}
      </form>

      {typeSheet && createPortal(
        <div className="crop-overlay" data-testid="type-sheet" onClick={() => setTypeSheet(false)}>
          <div className="card stack crop-card" onClick={(e) => e.stopPropagation()}>
            <div className="row between"><strong>Pick a type</strong>
              <button type="button" className="btn ghost sm" data-testid="type-sheet-close" onClick={() => setTypeSheet(false)}>Close</button>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {moreTypes.map((et) => (
                <button type="button" key={et.value} className={`chip sm ${type === et.value && !custom ? "on" : ""}`}
                  data-testid={`sheet-type-${et.value}`}
                  onClick={() => { pickPreset(et.value); setTypeSheet(false); }}>{et.emoji} {et.label}</button>
              ))}
            </div>
            {savedTypes.length > 0 && (
              <>
                <label className="field" style={{ marginBottom: 0 }}>Your types</label>
                <div className="row wrap" style={{ gap: 6 }}>
                  {savedTypes.map((t) => (
                    <span key={t.label} role="button" tabIndex={0}
                      className={`chip sm ${custom?.label === t.label ? "on" : ""}`}
                      data-testid={`sheet-custom-${t.label.toLowerCase()}`}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                      onClick={() => { pickSaved(t); setTypeSheet(false); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { pickSaved(t); setTypeSheet(false); } }}>
                      {t.emoji} {t.label}
                      <SavedTypeDelete label={t.label} onDeleted={() => { if (custom?.label === t.label) setCustom(null); reloadTypes(); }} />
                    </span>
                  ))}
                </div>
              </>
            )}
            <NewTypeInput onCreate={(label) => {
              setType("other");
              setCustom({ emoji: CUSTOM_TYPE_ICON, label });
              setTypeSheet(false);
            }} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// Name a brand-new custom type - no emoji picker; the system assigns the icon.
function NewTypeInput({ onCreate }: { onCreate: (label: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div>
      <label className="field" htmlFor="nt" style={{ marginBottom: 4 }}>Something else?</label>
      <div className="row" style={{ gap: 6 }}>
        <input id="nt" className="input" data-testid="newtype-name" value={name} maxLength={20}
          placeholder="Name a new type" onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn sm" style={{ flex: "none" }} data-testid="newtype-save"
          disabled={!name.trim()} onClick={() => onCreate(name.trim())}>Use it</button>
      </div>
    </div>
  );
}

// Two-tap delete for a saved custom type (mirrors every other remove).
function SavedTypeDelete({ label, onDeleted }: { label: string; onDeleted: () => void }) {
  const api = useApi();
  const [armed, setArmed] = useState(false);
  return (
    <button type="button" aria-label={`Delete ${label}`}
      data-testid={`custom-del-${label.toLowerCase()}`}
      style={{ all: "unset", cursor: "pointer", paddingLeft: 2, opacity: armed ? 1 : 0.6,
        color: armed ? "var(--no)" : undefined, fontWeight: armed ? 800 : undefined }}
      onClick={async (e) => {
        e.stopPropagation();
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        await api(`/api/event-types/${encodeURIComponent(label)}`, { method: "DELETE" });
        onDeleted();
      }}>{armed ? "✕?" : "✕"}</button>
  );
}
