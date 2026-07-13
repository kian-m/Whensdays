import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Event, fmtMinutes, gridSlots, hostTimezone, sendJSON, toDatetimeLocal, useApi } from "../lib";
import { MonthPicker } from "../ui";
import { DEV_AUTH } from "../App";

// 30-min time choices for the 'dates'-poll grid window (12:00 AM → 11:30 PM).
const TIME_CHOICES = gridSlots(0, 1440, 30);

// Native min-validation would block dev/E2E backdating (streaks, Past tab) -
// the server enforces the same rule with the same dev exemption.
const MIN_DT = DEV_AUTH ? undefined : toDatetimeLocal(new Date().toISOString());

// Quick plan: the 10-second path. Either set a time, or open it up so everyone
// marks when they're free (a general-availability poll) - you lock it in from
// the results. Lands on the event page ready to share. The full wizard (/new)
// remains for types, visibility, and invites.
export function Quick() {
  const api = useApi();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"fixed" | "general">("fixed");
  const [scope, setScope] = useState<"week" | "month" | "general" | "dates">("week");
  const [when, setWhen] = useState("");
  // 'dates' scope: host-picked days (YYYY-MM-DD) + the grid's time window.
  const [pollDays, setPollDays] = useState<Set<string>>(new Set());
  const [gridStart, setGridStart] = useState(540); // 9:00 AM
  const [gridEnd, setGridEnd] = useState(1260); // 9:00 PM
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const valid = title.trim() !== ""
    && (mode === "fixed" ? !!when : scope === "dates" ? pollDays.size > 0 : true);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    const body: Record<string, unknown> = {
      title,
      event_type: "other",
      description: "",
      location_mode: "host_place",
      location_address: "",
      scheduling_mode: mode,
      visibility: "private",
      timezone: hostTimezone(),
    };
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
    setSaving(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setErr(b.error || "could not create");
    }
    const ev: Event = await res.json();
    // First event ever created on this device -> suggest add-to-homescreen
    // once (the event page shows it; localStorage is the once-gate).
    try {
      if (!localStorage.getItem("whensdays.a2hs")) sessionStorage.setItem("whensdays.a2hs-pending", "1");
    } catch { /* private mode */ }
    nav(`/e/${ev.id}`);
  }

  return (
    <div className="stack" style={{ maxWidth: 460, margin: "1rem auto" }}>
      <h1>⚡ Quick plan</h1>
      <p className="muted small">Name it, pick how you'll set the time - share the link, done.</p>
      <form className="card stack" onSubmit={go}>
        <input className="input" maxLength={140} data-testid="quick-title" value={title} autoFocus
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
        <p className="muted small" style={{ textAlign: "center" }}>
          Need types, visibility or invites? <Link to="/new" style={{ textDecoration: "underline" }}>Full setup</Link>
        </p>
      </form>
    </div>
  );
}
