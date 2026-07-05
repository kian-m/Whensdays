import { useState } from "react";
import { Profile, sendJSON, useApi } from "../lib";

// First-run gate: one field — a name. The handle is optional (we derive one
// server-side when left blank).
export function ProfileSetup({ onDone }: { onDone: (p: Profile) => void }) {
  const api = useApi();
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await sendJSON(api, "PUT", "/api/profile", { display_name: displayName, handle });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return setError(body.error || "could not save profile");
    }
    onDone(await res.json());
  }

  return (
    <div className="stack" style={{ maxWidth: 420, margin: "2rem auto" }}>
      <h1>Welcome 👋</h1>
      <p className="muted">Just your name and you're in.</p>
      <form className="card stack" onSubmit={save}>
        <div>
          <label className="field" htmlFor="dn">Your name</label>
          <input
            id="dn"
            className="input"
            data-testid="setup-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Alex Rivera"
          />
        </div>
        <div>
          <label className="field" htmlFor="hd">Handle <span className="muted small">(optional — we’ll pick one)</span></label>
          <input
            id="hd"
            className="input"
            data-testid="setup-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="alex"
          />
          <p className="muted small" style={{ marginTop: 4 }}>Friends add you by this. Letters, numbers, _ or -.</p>
        </div>
        {error && <p className="err">{error}</p>}
        <button className="btn btn-block" data-testid="setup-save" disabled={saving}>
          {saving ? "Saving…" : "Let's go"}
        </button>
      </form>
    </div>
  );
}
