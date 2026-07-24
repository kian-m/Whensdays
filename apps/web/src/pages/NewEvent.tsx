import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Event, fmtMinutes, getJSON, gridSlots, hostTimezone, sendJSON, toDatetimeLocal, useApi } from "../lib";
import { MonthPicker } from "../ui";
import { DEV_AUTH } from "../App";
import { EVENTS, analytics } from "../analytics";

// 30-min time choices for the 'dates'-poll grid window (12:00 AM → 11:30 PM).
const TIME_CHOICES = gridSlots(0, 1440, 30);

// Native min-validation would block dev/E2E backdating (streaks, Past tab) -
// the server enforces the same rule with the same dev exemption.
const MIN_DT = DEV_AUTH ? undefined : toDatetimeLocal(new Date().toISOString());

// The ONE way to create an event. Name it, then either set a time yourself or
// open it up so everyone marks when they're free (a general-availability poll,
// with the scope chosen right here) - you lock it in from the results. Lands on
// the event page ready to share; type, cover, theme, location, capacity and
// description are all set afterward via edit-in-place on the event.
//
// Three query params drive the entry points:
//  - ?group=<id>   attach the new event to that group (create is gated to the
//                  group's owner/admins server-side).
//  - ?again=<id>   "Plan the next one" (recap email / a past event): prefill the
//                  title AND silently CLONE the source event's look + content
//                  (description, location, cover photo/GIF, theme) so the result
//                  is a full copy with a fresh time - there's no form UI for
//                  those fields, they ride through the create payload.
//  - ?repoll=1     (with ?again) default to the availability poll and re-invite
//                  the source event's people (invite_from) on create.
export function NewEvent() {
  const api = useApi();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const groupId = params.get("group") || "";
  const againId = params.get("again") || "";
  const repoll = params.get("repoll") === "1" && !!againId;

  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"fixed" | "general">(repoll ? "general" : "fixed");
  const [scope, setScope] = useState<"week" | "month" | "general" | "dates">("week");
  const [when, setWhen] = useState("");
  // 'dates' scope: host-picked days (YYYY-MM-DD) + the grid's time window.
  const [pollDays, setPollDays] = useState<Set<string>>(new Set());
  const [gridStart, setGridStart] = useState(540); // 9:00 AM
  const [gridEnd, setGridEnd] = useState(1260); // 9:00 PM
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Group context (name) when launched from a group page - implicit, read-only.
  const [groupName, setGroupName] = useState("");
  // A ?again= re-host silently clones the source event's look/content into the
  // create payload (no form UI for these). Cover/theme aren't create-endpoint
  // fields, so they ride a follow-up PUT after the event exists.
  const [clone, setClone] = useState<{
    description: string; location_mode: "host_place" | "find_venue" | "virtual";
    location_address: string; photo_url: string; theme: string;
  } | null>(null);

  useEffect(() => {
    analytics.capture(EVENTS.createEventOpened, againId ? { again: true } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!groupId) return;
    getJSON<{ name: string; emoji: string }>(api, `/api/groups/${groupId}/preview`)
      .then((g) => setGroupName(`${g.emoji} ${g.name}`.trim()))
      .catch(() => { /* stale link - no context line */ });
  }, [api, groupId]);

  useEffect(() => {
    if (!againId) return;
    getJSON<{ event: {
      title: string; description: string; location_mode: "host_place" | "find_venue" | "virtual";
      location_address: string; photo_url: string; theme: string;
    } }>(api, `/api/events/${againId}`).then((d) => {
      setTitle(d.event.title);
      setClone({
        description: d.event.description || "",
        location_mode: d.event.location_mode,
        location_address: d.event.location_address || "",
        photo_url: d.event.photo_url || "",
        theme: d.event.theme || "",
      });
    }).catch(() => { /* stale link - start blank */ });
  }, [api, againId]);

  const valid = title.trim() !== ""
    && (mode === "fixed" ? !!when : scope === "dates" ? pollDays.size > 0 : true);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    // Fresh events start as a plain host place; a ?again= clone overrides
    // look/content with the source event's.
    const body: Record<string, unknown> = {
      title,
      description: clone?.description ?? "",
      location_mode: clone?.location_mode ?? "host_place",
      location_address: clone?.location_address ?? "",
      scheduling_mode: mode,
      visibility: "private",
      timezone: hostTimezone(),
    };
    if (groupId) body.group_id = groupId;
    if (repoll) body.invite_from = againId;
    if (mode === "fixed") body.starts_at = when ? new Date(when).toISOString() : "";
    else {
      body.general_scope = scope; // shapes what guests are asked (week/month/generally/dates)
      if (scope === "dates") {
        body.poll_days = [...pollDays].sort();
        body.grid_start = gridStart;
        body.grid_end = gridEnd;
      }
    }
    const res = await sendJSON(api, "POST", "/api/events", body);
    if (!res.ok) {
      setSaving(false);
      const b = await res.json().catch(() => ({}));
      return setErr(b.error || "could not create");
    }
    const ev: Event = await res.json();
    // Clone the cover + theme (not create-endpoint fields) onto the new event so
    // the re-host is a full look-alike; best-effort (edit-in-place can fix it).
    if (clone && (clone.photo_url || clone.theme)) {
      await sendJSON(api, "PUT", `/api/events/${ev.id}`, {
        title, description: clone.description, location_mode: clone.location_mode,
        location_address: clone.location_address, visibility: "private",
        photo_url: clone.photo_url, theme: clone.theme,
      }).catch(() => { /* best-effort clone of the look */ });
    }
    setSaving(false);
    // First event ever created on this device -> suggest add-to-homescreen
    // once (the event page shows it; localStorage is the once-gate).
    try {
      if (!localStorage.getItem("whensdays.a2hs")) sessionStorage.setItem("whensdays.a2hs-pending", "1");
    } catch { /* private mode */ }
    nav(`/e/${ev.id}`);
  }

  return (
    <div className="stack" style={{ maxWidth: 460, margin: "1rem auto" }}>
      <div className="row between">
        <h1>New event</h1>
        {groupName && <span className="muted small" data-testid="group-context">{groupName}</span>}
      </div>
      <p className="muted small">Name it, pick how you'll set the time - share the link, done.</p>
      <form className="card stack" onSubmit={go}>
        <label className="field" htmlFor="t">What's the plan?</label>
        <input id="t" className="input" maxLength={140} data-testid="quick-title" value={title} autoFocus
          placeholder="Pizza night, study session, pickup game…" onChange={(e) => setTitle(e.target.value)} />
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className={`chip sm ${mode === "fixed" ? "on" : ""}`}
            data-testid="quick-mode-fixed" onClick={() => setMode("fixed")}>I'll set the time</button>
          <button type="button" className={`chip sm ${mode === "general" ? "on" : ""}`}
            data-testid="quick-mode-avail" onClick={() => setMode("general")}>Ask when people are free</button>
        </div>
        {mode === "fixed" ? (
          <input type="datetime-local" className="input" min={MIN_DT} data-testid="quick-when" value={when}
            onChange={(e) => setWhen(e.target.value)} />
        ) : (
          <>
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="muted small">Ask about:</span>
              {([["week", "This week"], ["month", "This month"], ["general", "Generally"], ["dates", "Pick days"]] as const).map(([v, l]) => (
                <button key={v} type="button" className={`chip sm ${scope === v ? "on" : ""}`}
                  data-testid={`quick-scope-${v}`} onClick={() => setScope(v)}>{l}</button>
              ))}
            </div>
            <p className="muted small">
              {scope === "week" && "Everyone marks the days and times that work over the next 7 days - you lock it in from the results."}
              {scope === "month" && "Everyone taps the days that work over the next 4 weeks - you lock it in from the results."}
              {scope === "general" && "Everyone marks the months, days and times that generally work for them - you lock it in from the results."}
              {scope === "dates" && "Pick the exact days you're considering, then everyone paints the actual times that work on each - you lock it in from the results."}
            </p>
            {scope === "dates" && (
              <div className="stack" style={{ gap: 8 }}>
                <MonthPicker selected={pollDays} onToggle={(d) => setPollDays((s) => {
                  const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n;
                })} />
                <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
                  <span className="muted small">Between</span>
                  <select className="input" style={{ maxWidth: 130 }} data-testid="grid-start" value={gridStart}
                    onChange={(e) => setGridStart(Number(e.target.value))}>
                    {TIME_CHOICES.filter((m) => m < gridEnd).map((m) => <option key={m} value={m}>{fmtMinutes(m)}</option>)}
                  </select>
                  <span className="muted small">and</span>
                  <select className="input" style={{ maxWidth: 130 }} data-testid="grid-end" value={gridEnd}
                    onChange={(e) => setGridEnd(Number(e.target.value))}>
                    {TIME_CHOICES.filter((m) => m > gridStart).map((m) => <option key={m} value={m}>{fmtMinutes(m)}</option>)}
                  </select>
                </div>
                {pollDays.size === 0 && <p className="muted small" style={{ margin: 0 }} data-testid="dates-hint">Tap at least one day above.</p>}
              </div>
            )}
          </>
        )}
        {err && <p className="err">{err}</p>}
        <button className="btn btn-block" data-testid="quick-create" disabled={saving || !valid}>
          {saving ? "Creating…" : "Create & get the link"}
        </button>
      </form>
    </div>
  );
}
