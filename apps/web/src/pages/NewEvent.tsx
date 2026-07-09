import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CATEGORIES, CITY_OPTIONS, Event, EventType, Friend, getJSON, guessCity, hostTimezone, sendJSON, toDatetimeLocal, useApi } from "../lib";
// (custom types: saved per user, offered as chips next to the presets)
import { EVENT_TYPES } from "../scheduler/questions";
import { AddressInput, Avatar, useAsync } from "../ui";
import { DEV_AUTH } from "../App";

// Native min-validation would block dev/E2E backdating - server enforces the
// same rule with the same dev exemption.
const MIN_DT = DEV_AUTH ? undefined : toDatetimeLocal(new Date().toISOString());
import { EVENTS, analytics } from "../analytics";

// Event creation is a one-step-at-a-time wizard (à la Airtable forms): What →
// Where → When → Who, with Back/Next. The Who step covers visibility AND lets
// the host invite friends before the event even exists.
const STEPS = ["What", "Where", "When", "Who"] as const;

export function NewEvent() {
  const api = useApi();
  const nav = useNavigate();
  // Arriving from a group page (?group=<id>) attaches the event to that group.
  const [params] = useSearchParams();
  const groupId = params.get("group") || "";
  // "Plan the next one" (?again=<eventId>, from the recap email / a past event):
  // prefill the wizard from that event so re-hosting is one pass of Next-taps.
  const againId = params.get("again") || "";
  // Re-poll (?repoll=1, from the series-ended email / series card): default to a
  // time poll and re-invite everyone from the source event on create.
  const repoll = params.get("repoll") === "1" && !!againId;

  useEffect(() => {
    analytics.capture(EVENTS.createEventOpened, againId ? { again: true } : undefined);
  }, []);

  useEffect(() => {
    if (!againId) return;
    getJSON<{ event: { title: string; event_type: EventType; description: string; location_mode: "host_place" | "find_venue"; location_address: string } }>(
      api, `/api/events/${againId}`,
    ).then((d) => {
      if (repoll) setSchedulingMode("poll");
      setTitle(d.event.title);
      setType(d.event.event_type);
      setDescription(d.event.description);
      setLocationMode(d.event.location_mode);
      setAddress(d.event.location_address);
    }).catch(() => { /* stale link - start blank */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [againId]);

  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<EventType>("dinner");
  const [description, setDescription] = useState("");
  const [locationMode, setLocationMode] = useState<"host_place" | "find_venue">("host_place");
  const [address, setAddress] = useState("");
  const [schedulingMode, setSchedulingMode] = useState<"fixed" | "poll" | "general">("fixed");
  const [generalScope, setGeneralScope] = useState<"week" | "month" | "general">("general");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState(""); // optional end time (fixed mode)
  const [repeat, setRepeat] = useState<"" | "weekly" | "biweekly" | "monthly">("");
  const [repeatCount, setRepeatCount] = useState(4);
  // Irregular series: extra explicit dates (any days - recurring, no pattern).
  const [moreStarts, setMoreStarts] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<"private" | "friends" | "public">("private");
  const [topic, setTopic] = useState("");
  const [city, setCity] = useState(guessCity());
  const [options, setOptions] = useState<string[]>([""]);
  const [invitees, setInvitees] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: fr } = useAsync<{ friends: Friend[] }>((a) => getJSON(a, "/api/friends"));
  const friends = fr?.friends ?? [];
  const { data: ct, reload: reloadTypes } = useAsync<{ types: { label: string; emoji: string }[] }>((a) => getJSON(a, "/api/event-types"));
  const savedTypes = ct?.types ?? [];

  // User-defined type: emoji + short name (server caps at 10 chars).
  const [custom, setCustom] = useState<{ emoji: string; label: string } | null>(null);
  const [addingType, setAddingType] = useState(false);
  const [newEmoji, setNewEmoji] = useState("🌀");
  const [newName, setNewName] = useState("");
  const CUSTOM_EMOJIS = [
    "🌀", "🎳", "🎤", "🎧", "🎹", "🎸", "🥁", "🎻", "🎭", "🎪", "🎨", "🖌️", "📸", "🎬",
    "🧑‍🍳", "🍕", "🌮", "🍣", "🥘", "🧁", "🍦", "☕️", "🍵", "🥂", "🍷", "🫕", "🥩", "🥗",
    "🛶", "🏓", "🎾", "⚽️", "🏀", "🏈", "⚾️", "🏐", "🏸", "🥏", "🎿", "🏂", "⛸️", "🛼",
    "🚴", "🏃", "🧗", "🏋️", "🧘", "🤸", "🏹", "🎣", "🏇", "🏄", "🤿", "🛹", "⛳️", "🥾",
    "🐕", "🐈", "🐎", "🦜", "🌊", "🏔️", "🏕️", "🌅", "🌸", "🍂", "❄️", "🔥", "⭐️", "🌙",
    "🧺", "🎡", "🎢", "🎯", "🎰", "🃏", "♟️", "🧩", "🪁", "🪅", "📚", "✍️", "🔭", "🔬",
    "🚗", "✈️", "🚂", "⛵️", "🎫", "🗺️", "🏛️", "⛪️", "💃", "🕺", "👾", "🤖", "🛍️", "💐",
  ];

  function setOption(i: number, v: string) {
    setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  }
  function toggleInvite(id: string) {
    setInvitees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Per-step validation gates Next/Create.
  function stepValid(i: number): boolean {
    if (i === 0) return title.trim() !== "";
    if (i === 2) {
      if (schedulingMode === "fixed") return startsAt !== "";
      if (schedulingMode === "poll") return options.some((o) => o.trim() !== "");
    }
    return true;
  }

  async function submit() {
    setError(null);
    // No past dates (server enforces too; dev mode is exempt so hermetic E2E
    // can simulate history for streaks / the Past tab).
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
      location_address: locationMode === "host_place" ? address : "",
      scheduling_mode: schedulingMode,
      timezone: hostTimezone(),
    };
    if (groupId) body.group_id = groupId;
    if (repoll) body.invite_from = againId;
    if (custom) {
      body.custom_emoji = custom.emoji;
      body.custom_label = custom.label;
    }
    body.visibility = visibility;
    if (visibility === "public") {
      body.topic = topic; // a preset category slug (or empty)
      body.city = city.trim();
    }
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
    if (schedulingMode === "general") {
      // Scope shapes the question guests answer (this week / this month / generally).
      body.general_scope = generalScope;
    }
    const res = await sendJSON(api, "POST", "/api/events", body);
    if (!res.ok) {
      setSaving(false);
      const b = await res.json().catch(() => ({}));
      return setError(b.error || "could not create event");
    }
    const ev: Event = await res.json();
    // Fire the wizard-selected invites (best-effort; the event page can retry).
    for (const friendId of invitees) {
      await sendJSON(api, "POST", `/api/events/${ev.id}/invites`, { friend_id: friendId }).catch(() => {});
    }
    nav(`/e/${ev.id}`);
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>New event</h1>
        <span className="muted small" data-testid="wiz-progress">Step {step + 1} of {STEPS.length} · {STEPS[step]}</span>
      </div>
      <div className="row" style={{ gap: 5 }}>
        {STEPS.map((s, i) => (
          <span key={s} style={{
            flex: 1, height: 4, borderRadius: 999,
            background: i <= step ? "var(--accent)" : "var(--line)",
          }} />
        ))}
      </div>

      <form className="card stack" style={{ minHeight: 460 }} onSubmit={(e) => e.preventDefault()}>
        {step === 0 && (
          <>
            <div>
              <label className="field" htmlFor="t">What's the plan?</label>
              <input id="t" className="input" data-testid="event-title" value={title}
                onChange={(e) => setTitle(e.target.value)} placeholder="Friday dinner" autoFocus />
            </div>
            <div>
              <label className="field">Type</label>
              <div className="row wrap">
                {EVENT_TYPES.map((et) => (
                  <button type="button" key={et.value}
                    className={`chip ${type === et.value && !custom ? "on" : ""}`}
                    data-testid={`type-${et.value}`}
                    onClick={() => { setType(et.value); setCustom(null); }}>
                    {et.emoji} {et.label}
                  </button>
                ))}
                {custom && !savedTypes.some((t) => t.label === custom.label) && (
                  <button type="button" className="chip on"
                    data-testid={`custom-${custom.label.toLowerCase()}`}
                    onClick={() => setAddingType(true)}>
                    {custom.emoji} {custom.label}
                  </button>
                )}
                {savedTypes.map((t) => (
                  /* Selectable chip with a nested delete ✕. The wrapper carries
                     the testid + `on` styling and handles selection (buttons
                     can't nest, so only the ✕ is a real <button>). */
                  <span key={t.label} role="button" tabIndex={0}
                    className={`chip ${custom?.label === t.label ? "on" : ""}`}
                    data-testid={`custom-${t.label.toLowerCase()}`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                    onClick={() => { setType("other"); setCustom({ emoji: t.emoji, label: t.label }); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { setType("other"); setCustom({ emoji: t.emoji, label: t.label }); } }}>
                    {t.emoji} {t.label}
                    <button type="button" aria-label={`Delete ${t.label}`}
                      data-testid={`custom-del-${t.label.toLowerCase()}`}
                      style={{ all: "unset", cursor: "pointer", opacity: 0.6, paddingLeft: 2 }}
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api(`/api/event-types/${encodeURIComponent(t.label)}`, { method: "DELETE" });
                        if (custom?.label === t.label) setCustom(null);
                        reloadTypes();
                      }}>✕</button>
                  </span>
                ))}
                <button type="button" className={`chip ${addingType ? "on" : ""}`} data-testid="type-add"
                  onClick={() => setAddingType((a) => !a)}>＋</button>
              </div>
              {addingType && (
                <div className="stack" style={{ marginTop: 8, gap: 6 }}>
                  <div className="emoji-strip" data-testid="newtype-emojis">
                    {CUSTOM_EMOJIS.map((em) => (
                      <button key={em} type="button" className={`chip sm ${newEmoji === em ? "on" : ""}`}
                        data-testid={`newtype-emoji-${em}`} onClick={() => setNewEmoji(em)}>{em}</button>
                    ))}
                  </div>
                  <div className="row">
                    <input className="input" data-testid="newtype-name" value={newName} maxLength={20}
                      placeholder="Name" onChange={(e) => setNewName(e.target.value)} />
                    <button type="button" className="btn sm" data-testid="newtype-save"
                      disabled={!newName.trim()}
                      onClick={() => {
                        setType("other");
                        setCustom({ emoji: newEmoji, label: newName.trim() });
                        setAddingType(false);
                        setNewName("");
                      }}>Use it</button>
                  </div>
                </div>
              )}

            </div>
            <div>
              <label className="field" htmlFor="d">Details <span className="muted small">(optional)</span></label>
              <textarea id="d" className="input" value={description}
                onChange={(e) => setDescription(e.target.value)} placeholder="Anything guests should know" />
            </div>
          </>
        )}

        {step === 1 && (
          <div>
            <label className="field">Where</label>
            <div className="row wrap">
              <button type="button" className={`chip ${locationMode === "host_place" ? "on" : ""}`}
                data-testid="loc-host" onClick={() => setLocationMode("host_place")}>📍 I’ll set the address</button>
              <button type="button" className={`chip ${locationMode === "find_venue" ? "on" : ""}`}
                data-testid="loc-venue" onClick={() => setLocationMode("find_venue")}>📍 Set location later</button>
            </div>
            {locationMode === "host_place" ? (
              <div style={{ marginTop: 8 }}>
                <AddressInput value={address} onChange={setAddress} placeholder="Start typing an address…" testid="event-address" />
              </div>
            ) : (
              <p className="muted small" style={{ marginTop: 8 }}>We'll help pick a spot once the group is set.</p>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <label className="field">When</label>
            <div className="row wrap">
              <button type="button" className={`chip ${schedulingMode === "fixed" ? "on" : ""}`}
                data-testid="sched-fixed" onClick={() => setSchedulingMode("fixed")}>I'll set a time</button>
              <button type="button" className={`chip ${schedulingMode === "poll" ? "on" : ""}`}
                data-testid="sched-poll" onClick={() => setSchedulingMode("poll")}>Poll specific times</button>
              <button type="button" className={`chip ${schedulingMode === "general" ? "on" : ""}`}
                data-testid="sched-general" onClick={() => setSchedulingMode("general")}>Poll general availability</button>
            </div>

            {schedulingMode === "fixed" && (
              <div className="stack" style={{ marginTop: 8 }}>
                <input type="datetime-local" className="input" min={MIN_DT}
                  data-testid="fixed-time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                <label className="field" style={{ marginBottom: 0 }}>Ends <span className="muted small">(optional)</span>
                  <input type="datetime-local" className="input" min={startsAt || MIN_DT}
                    data-testid="fixed-end" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </label>
                {/* Irregular series: stack more explicit dates (any days). Mutually
                    exclusive with a repeat pattern - picking dates clears it. */}
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
                  <p className="muted small">These dates become one series - everyone RSVPs per date.</p>
                )}
              </div>
            )}
            {schedulingMode === "poll" && (
              <div className="stack" style={{ marginTop: 8 }}>
                {options.map((o, i) => (
                  <input key={i} type="datetime-local" className="input" min={MIN_DT} data-testid={`poll-option-${i}`}
                    value={o} onChange={(e) => setOption(i, e.target.value)} />
                ))}
                <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }}
                  data-testid="add-option" onClick={() => setOptions((o) => [...o, ""])}>+ Add another time</button>
              </div>
            )}
            {schedulingMode === "general" && (
              <div className="stack" style={{ marginTop: 8, gap: 6 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="muted small">Ask about:</span>
                  {([["week", "This week"], ["month", "This month"], ["general", "Generally"]] as const).map(([v, l]) => (
                    <button key={v} type="button" className={`chip sm ${generalScope === v ? "on" : ""}`}
                      data-testid={`scope-${v}`} onClick={() => setGeneralScope(v)}>{l}</button>
                  ))}
                </div>
                <p className="muted small" style={{ margin: 0 }}>
                  {generalScope === "week" && "Guests mark which days and times work over the next 7 days. You'll lock in a time from the results."}
                  {generalScope === "month" && "Guests tap the days that work over the next 4 weeks. You'll lock in a time from the results."}
                  {generalScope === "general" && "Guests pick their ideal months, days of the week, and times of day (early morning → night). You'll lock in a time from the results."}
                </p>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="field">Who can find it?</label>
              <div className="row wrap">
                <button type="button" className={`chip ${visibility === "private" ? "on" : ""}`}
                  data-testid="vis-private" onClick={() => setVisibility("private")}>🔒 Invite-only</button>
                <button type="button" className={`chip ${visibility === "friends" ? "on" : ""}`}
                  data-testid="vis-friends" onClick={() => setVisibility("friends")}>🤝 Friends</button>
                <button type="button" className={`chip ${visibility === "public" ? "on" : ""}`}
                  data-testid="vis-public" onClick={() => setVisibility("public")}>🌎 Public (on Discover)</button>
              </div>
              {visibility === "public" && (
                <div className="stack" style={{ marginTop: 8, gap: 8 }}>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {CATEGORIES.map((c) => (
                      <button key={c.slug} type="button" className={`chip sm ${topic === c.slug ? "on" : ""}`}
                        data-testid={`cat-${c.slug}`}
                        onClick={() => setTopic(topic === c.slug ? "" : c.slug)}>{c.emoji} {c.label}</button>
                    ))}
                  </div>
                  <input className="input" data-testid="event-city" list="city-list" value={city}
                    placeholder="city (optional)" onChange={(e) => setCity(e.target.value)} />
                  <datalist id="city-list">
                    {CITY_OPTIONS.map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
              )}
            </div>
            <div>
              <label className="field">Invite friends? <span className="muted small">(optional - they'll see it on their dashboard)</span></label>
              {friends.length === 0 && <p className="muted small">No friends yet - add some on the Friends page, or share the invite link after creating.</p>}
              <div className="row wrap" style={{ gap: 6 }}>
                {friends.map((f) => (
                  <button key={f.friend_id} type="button"
                    className={`chip sm ${invitees.has(f.friend_id) ? "on" : ""}`}
                    data-testid={`winvite-${f.handle}`}
                    onClick={() => toggleInvite(f.friend_id)}>
                    <Avatar url={f.avatar_url} name={f.display_name} size={18} /> {f.display_name}
                  </button>
                ))}
              </div>
              {invitees.size > 0 && <p className="muted small" style={{ marginTop: 6 }}>{invitees.size} to invite</p>}
            </div>
          </>
        )}

        {error && <p className="err">{error}</p>}

        <div className="row between">
          <button type="button" className="btn ghost sm" data-testid="wiz-back"
            onClick={() => (step === 0 ? nav("/") : setStep((s) => s - 1))}>← Back</button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn" data-testid="wiz-next"
              disabled={!stepValid(step)} onClick={() => setStep((s) => s + 1)}>Next →</button>
          ) : (
            <button type="button" className="btn" data-testid="create-event"
              disabled={saving || !stepValid(2)} onClick={submit}>
              {saving ? "Creating…" : "Create event"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
