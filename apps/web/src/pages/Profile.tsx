import { useEffect, useState } from "react";
import {
  AvailabilitySlot,
  PARTS,
  Profile,
  WEEKDAYS,
  getJSON,
  sendJSON,
  useApi,
  useProfile,
} from "../lib";
import { Loading, useAsync } from "../ui";

// The whole profile: a name, a handle, and a general weekly availability grid.
// Deliberately tiny — accepting an event later layers concrete commitments on top.
export function ProfilePage({ onUpdated }: { onUpdated: (p: Profile) => void }) {
  const api = useApi();
  const profile = useProfile();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: slots, loading } = useAsync<AvailabilitySlot[]>((a) => getJSON(a, "/api/availability"));
  const [free, setFree] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (slots) setFree(new Set(slots.map((s) => `${s.weekday}-${s.part_of_day}`)));
  }, [slots]);

  function toggle(wd: number, part: string) {
    const key = `${wd}-${part}`;
    setFree((f) => {
      const next = new Set(f);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await sendJSON(api, "PUT", "/api/profile", { display_name: displayName, handle });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setError(b.error || "could not save");
    }
    onUpdated(await res.json());
    setSavedMsg("Profile saved ✓");
  }

  async function saveAvailability() {
    const payload = [...free].map((k) => {
      const [weekday, part_of_day] = k.split("-");
      return { weekday: Number(weekday), part_of_day };
    });
    await sendJSON(api, "PUT", "/api/availability", { slots: payload });
    setSavedMsg("Availability saved ✓");
  }

  if (loading) return <Loading />;

  return (
    <div className="stack">
      <h1>Profile</h1>

      <form className="card stack" onSubmit={saveProfile}>
        <div>
          <label className="field" htmlFor="dn">Name</label>
          <input id="dn" className="input" data-testid="profile-name" value={displayName}
            onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div>
          <label className="field" htmlFor="hd">Handle</label>
          <input id="hd" className="input" data-testid="profile-handle" value={handle}
            onChange={(e) => setHandle(e.target.value)} />
        </div>
        {error && <p className="err">{error}</p>}
        <button className="btn" style={{ alignSelf: "flex-start" }} data-testid="save-profile">Save</button>
      </form>

      <div className="card stack">
        <div>
          <h3>When are you usually free?</h3>
          <p className="muted small">Tap the times that generally work. Friends can see this.</p>
        </div>
        <div className="grid" data-testid="availability-grid">
          <div />
          {PARTS.map((p) => <div key={p} className="hd">{p}</div>)}
          {WEEKDAYS.map((d, wd) => (
            <RowEdit key={wd} day={d} wd={wd} free={free} toggle={toggle} />
          ))}
        </div>
        <button className="btn soft" style={{ alignSelf: "flex-start" }} data-testid="save-availability"
          onClick={saveAvailability}>Save availability</button>
      </div>

      {savedMsg && <p className="muted small">{savedMsg}</p>}
    </div>
  );
}

function RowEdit({ day, wd, free, toggle }: {
  day: string; wd: number; free: Set<string>; toggle: (wd: number, p: string) => void;
}) {
  return (
    <>
      <div className="day">{day}</div>
      {PARTS.map((p) => (
        <button key={p} type="button" data-testid={`cell-${wd}-${p}`}
          className={`cell ${free.has(`${wd}-${p}`) ? "on" : ""}`} onClick={() => toggle(wd, p)} />
      ))}
    </>
  );
}
