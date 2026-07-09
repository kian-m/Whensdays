import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Event, hostTimezone, sendJSON, toDatetimeLocal, useApi } from "../lib";
import { DEV_AUTH } from "../App";

// Native min-validation would block dev/E2E backdating (streaks, Past tab) —
// the server enforces the same rule with the same dev exemption.
const MIN_DT = DEV_AUTH ? undefined : toDatetimeLocal(new Date().toISOString());

// Quick plan: the 10-second path. Either set a time, or open it up so everyone
// marks when they're free (a general-availability poll) — you lock it in from
// the results. Lands on the event page ready to share. The full wizard (/new)
// remains for types, visibility, and invites.
export function Quick() {
  const api = useApi();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"fixed" | "general">("fixed");
  const [scope, setScope] = useState<"week" | "month" | "general">("week");
  const [when, setWhen] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const valid = title.trim() !== "" && (mode === "fixed" ? !!when : true);

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
    else body.general_scope = scope; // shapes what guests are asked (week/month/generally)
    const res = await sendJSON(api, "POST", "/api/events", body);
    setSaving(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setErr(b.error || "could not create");
    }
    const ev: Event = await res.json();
    nav(`/e/${ev.id}`);
  }

  return (
    <div className="stack" style={{ maxWidth: 460, margin: "1rem auto" }}>
      <h1>⚡ Quick plan</h1>
      <p className="muted small">Name it, pick how you'll set the time — share the link, done.</p>
      <form className="card stack" onSubmit={go}>
        <input className="input" data-testid="quick-title" value={title} autoFocus
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
              {([["week", "This week"], ["month", "This month"], ["general", "Generally"]] as const).map(([v, l]) => (
                <button key={v} type="button" className={`chip sm ${scope === v ? "on" : ""}`}
                  data-testid={`quick-scope-${v}`} onClick={() => setScope(v)}>{l}</button>
              ))}
            </div>
            <p className="muted small">
              {scope === "week" && "Everyone marks the days and times that work over the next 7 days — you lock it in from the results."}
              {scope === "month" && "Everyone taps the days that work over the next 4 weeks — you lock it in from the results."}
              {scope === "general" && "Everyone marks the months, days and times that generally work for them — you lock it in from the results."}
            </p>
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
