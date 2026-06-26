import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Event, EventType, sendJSON, useApi } from "../lib";
import { EVENT_TYPES } from "../scheduler/questions";
import { EVENTS, analytics } from "../analytics";

// Stage one of an event's life: the host creates it, picks a location style, and
// either sets a fixed time or opens an availability poll with candidate times.
export function NewEvent() {
  const api = useApi();
  const nav = useNavigate();

  useEffect(() => {
    analytics.capture(EVENTS.createEventOpened);
  }, []);

  const [title, setTitle] = useState("");
  const [type, setType] = useState<EventType>("dinner");
  const [description, setDescription] = useState("");
  const [locationMode, setLocationMode] = useState<"host_place" | "find_venue">("host_place");
  const [address, setAddress] = useState("");
  const [schedulingMode, setSchedulingMode] = useState<"fixed" | "poll">("fixed");
  const [startsAt, setStartsAt] = useState("");
  const [options, setOptions] = useState<string[]>([""]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function setOption(i: number, v: string) {
    setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const body: Record<string, unknown> = {
      title,
      event_type: type,
      description,
      location_mode: locationMode,
      location_address: locationMode === "host_place" ? address : "",
      scheduling_mode: schedulingMode,
    };
    if (schedulingMode === "fixed") {
      body.starts_at = startsAt ? new Date(startsAt).toISOString() : "";
    } else {
      body.time_options = options
        .filter((o) => o.trim() !== "")
        .map((o) => new Date(o).toISOString());
    }
    const res = await sendJSON(api, "POST", "/api/events", body);
    setSaving(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setError(b.error || "could not create event");
    }
    const ev: Event = await res.json();
    nav(`/e/${ev.id}`);
  }

  return (
    <div className="stack">
      <h1>New event</h1>
      <form className="card stack" onSubmit={submit}>
        <div>
          <label className="field" htmlFor="t">What's the plan?</label>
          <input id="t" className="input" data-testid="event-title" value={title}
            onChange={(e) => setTitle(e.target.value)} placeholder="Friday dinner" />
        </div>

        <div>
          <label className="field">Type</label>
          <div className="row wrap">
            {EVENT_TYPES.map((et) => (
              <button type="button" key={et.value}
                className={`chip ${type === et.value ? "on" : ""}`}
                data-testid={`type-${et.value}`}
                onClick={() => setType(et.value)}>
                {et.emoji} {et.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="field" htmlFor="d">Details <span className="muted small">(optional)</span></label>
          <textarea id="d" className="input" value={description}
            onChange={(e) => setDescription(e.target.value)} placeholder="Anything guests should know" />
        </div>

        <div>
          <label className="field">Where</label>
          <div className="row wrap">
            <button type="button" className={`chip ${locationMode === "host_place" ? "on" : ""}`}
              data-testid="loc-host" onClick={() => setLocationMode("host_place")}>🏠 My place</button>
            <button type="button" className={`chip ${locationMode === "find_venue" ? "on" : ""}`}
              data-testid="loc-venue" onClick={() => setLocationMode("find_venue")}>📍 Help me find a venue</button>
          </div>
          {locationMode === "host_place" ? (
            <input className="input" style={{ marginTop: 8 }} value={address}
              onChange={(e) => setAddress(e.target.value)} placeholder="Address (optional)" />
          ) : (
            <p className="muted small" style={{ marginTop: 8 }}>We'll help pick a spot once the group is set.</p>
          )}
        </div>

        <div>
          <label className="field">When</label>
          <div className="row wrap">
            <button type="button" className={`chip ${schedulingMode === "fixed" ? "on" : ""}`}
              data-testid="sched-fixed" onClick={() => setSchedulingMode("fixed")}>I'll set a time</button>
            <button type="button" className={`chip ${schedulingMode === "poll" ? "on" : ""}`}
              data-testid="sched-poll" onClick={() => setSchedulingMode("poll")}>Poll for availability</button>
          </div>

          {schedulingMode === "fixed" ? (
            <input type="datetime-local" className="input" style={{ marginTop: 8 }}
              data-testid="fixed-time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          ) : (
            <div className="stack" style={{ marginTop: 8 }}>
              {options.map((o, i) => (
                <input key={i} type="datetime-local" className="input" data-testid={`poll-option-${i}`}
                  value={o} onChange={(e) => setOption(i, e.target.value)} />
              ))}
              <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }}
                data-testid="add-option" onClick={() => setOptions((o) => [...o, ""])}>+ Add time</button>
            </div>
          )}
        </div>

        {error && <p className="err">{error}</p>}
        <button className="btn btn-block" data-testid="create-event" disabled={saving}>
          {saving ? "Creating…" : "Create event"}
        </button>
      </form>
    </div>
  );
}
