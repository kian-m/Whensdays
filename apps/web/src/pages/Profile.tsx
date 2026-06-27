import { useEffect, useRef, useState } from "react";
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
import { Avatar, Loading, useAsync } from "../ui";

// Resize an image File to a small square JPEG data URL (cover crop), client-side
// — keeps avatars tiny so they can live as a data URL in the DB (no object store).
function fileToAvatar(file: File, size = 160): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("bad image"));
    img.src = URL.createObjectURL(file);
  });
}

// The whole profile: a name, a handle, and a general weekly availability grid.
// Deliberately tiny — accepting an event later layers concrete commitments on top.
export function ProfilePage({ onUpdated }: { onUpdated: (p: Profile) => void }) {
  const api = useApi();
  const profile = useProfile();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatar, setAvatar] = useState(profile?.avatar_url ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await fileToAvatar(file);
      const res = await sendJSON(api, "PUT", "/api/profile/avatar", { avatar_url: dataUrl });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        return setError(b.error || "could not save photo");
      }
      const p: Profile = await res.json();
      setAvatar(p.avatar_url);
      onUpdated(p);
      setSavedMsg("Photo updated ✓");
    } catch {
      setError("could not read image");
    }
  }

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
        <div className="row" style={{ gap: 14 }}>
          <Avatar url={avatar} name={displayName} size={64} />
          <div className="stack" style={{ gap: 4 }}>
            <button type="button" className="btn ghost sm" data-testid="avatar-pick"
              onClick={() => fileRef.current?.click()}>
              {avatar ? "Change photo" : "Add photo"}
            </button>
            <span className="muted small">A square JPEG/PNG works best.</span>
          </div>
          <input ref={fileRef} type="file" accept="image/*" data-testid="avatar-file"
            style={{ display: "none" }} onChange={onPickPhoto} />
        </div>
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
