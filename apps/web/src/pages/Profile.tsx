import { useEffect, useRef, useState } from "react";
import {
  AvailabilityDay,
  AvailabilitySlot,
  DAYPARTS,
  ImportedEvent,
  Profile,
  Theme,
  WEEKDAYS_FULL,
  WEEK_PARTS,
  applyTheme,
  daysFrom,
  getJSON,
  getTheme,
  importedBusy,
  sendJSON,
  useApi,
  useProfile,
} from "../lib";
import { useSearchParams } from "react-router-dom";
import { Avatar, DayGrid, Loading, Toast, fileToAvatar, useAsync } from "../ui";
import { CalendarConnections } from "./Calendars";

const PAGE = 14; // days of explicit availability shown per page
const MAX_OFFSET = 70; // furthest page start: 70..83 days out (~12 weeks ahead)

// Rows for the recurring weekly grid: Sunday…Saturday, keyed by weekday index.
const WEEK_ROWS = WEEKDAYS_FULL.map((label, i) => ({ value: String(i), label }));

// The whole profile: name, handle, photo, and availability — either a recurring
// weekly pattern OR explicit availability on concrete upcoming dates (paginated).
export function ProfilePage({ onUpdated }: { onUpdated: (p: Profile) => void }) {
  const api = useApi();
  const profile = useProfile();

  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  // The profile tile is read-only until Edit is pressed; Save flips it back.
  const [editing, setEditing] = useState(false);

  // Landing back from a calendar OAuth round-trip (?connected=google).
  const [sp, setSp] = useSearchParams();
  useEffect(() => {
    const connected = sp.get("connected");
    if (!connected) return;
    setSavedMsg(sp.get("status") ? "Calendar connection failed — try again." : "Calendar connected ✓");
    sp.delete("connected");
    sp.delete("status");
    setSp(sp, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatar, setAvatar] = useState(profile?.avatar_url ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  // Availability: a mode toggle plus the two data sets.
  const [mode, setMode] = useState<"specific" | "weekly">("specific");
  const [editingAvail, setEditingAvail] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [pageOffset, setPageOffset] = useState(0);
  const dates = daysFrom(pageOffset, PAGE);

  // Explicit date-based availability (the full set across all pages).
  const { data: days, loading } = useAsync<AvailabilityDay[]>((a) => getJSON(a, "/api/availability/days"));
  const [free, setFree] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (days) setFree(new Set(days.map((d) => `${d.day}:${d.daypart}`)));
  }, [days]);

  // Recurring weekly availability.
  const { data: slots } = useAsync<AvailabilitySlot[]>((a) => getJSON(a, "/api/availability"));

  // Imported-calendar busy times overlay the specific-dates grid (read-only).
  const { data: cal } = useAsync<{ events: ImportedEvent[] }>((a) => getJSON(a, "/api/calendar/events"));
  const busyCells = importedBusy(cal?.events ?? []).cells;
  const [week, setWeek] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (slots) setWeek(new Set(slots.map((s) => `${s.weekday}:${s.part_of_day}`)));
  }, [slots]);

  function mutate(setter: typeof setFree, fn: (s: Set<string>) => void) {
    setter((prev) => {
      const next = new Set(prev);
      fn(next);
      return next;
    });
  }

  // --- explicit-date grid handlers (operate on `free`) ---
  const toggleCell = (day: string, dp: string) => mutate(setFree, (s) => (s.has(`${day}:${dp}`) ? s.delete(`${day}:${dp}`) : s.add(`${day}:${dp}`)));
  const toggleRow = (day: string) => mutate(setFree, (s) => {
    const keys = DAYPARTS.map((dp) => `${day}:${dp.value}`);
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });
  const toggleCol = (dp: string) => mutate(setFree, (s) => {
    const keys = dates.map((d) => `${d.value}:${dp}`);
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });

  // --- weekly grid handlers (operate on `week`, keyed "weekday:part") ---
  const toggleWeekCell = (wd: string, dp: string) => mutate(setWeek, (s) => (s.has(`${wd}:${dp}`) ? s.delete(`${wd}:${dp}`) : s.add(`${wd}:${dp}`)));
  const toggleWeekRow = (wd: string) => mutate(setWeek, (s) => {
    const keys = WEEK_PARTS.map((p) => `${wd}:${p.value}`);
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });
  const toggleWeekCol = (dp: string) => mutate(setWeek, (s) => {
    const keys = WEEK_ROWS.map((r) => `${r.value}:${dp}`);
    const full = keys.every((k) => s.has(k));
    keys.forEach((k) => (full ? s.delete(k) : s.add(k)));
  });

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

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await sendJSON(api, "PUT", "/api/profile", { display_name: displayName, handle, email });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setError(b.error || "could not save");
    }
    onUpdated(await res.json());
    setSavedMsg("Profile saved ✓");
    setEditing(false);
  }

  async function saveAvailability() {
    const payload = [...free].map((k) => {
      const [day, daypart] = k.split(":");
      return { day, daypart };
    });
    await sendJSON(api, "PUT", "/api/availability/days", { days: payload });
    setSavedMsg("Availability saved ✓");
    setEditingAvail(false);
  }

  async function saveWeekly() {
    const slotsPayload = [...week].map((k) => {
      const [wd, part_of_day] = k.split(":");
      return { weekday: Number(wd), part_of_day };
    });
    await sendJSON(api, "PUT", "/api/availability", { slots: slotsPayload });
    setSavedMsg("Availability saved ✓");
    setEditingAvail(false);
  }

  // Discard edits: restore both grids from the last-loaded server data.
  function cancelAvail() {
    if (days) setFree(new Set(days.map((d) => `${d.day}:${d.daypart}`)));
    if (slots) setWeek(new Set(slots.map((sl) => `${sl.weekday}:${sl.part_of_day}`)));
    setEditingAvail(false);
  }

  if (loading && !days) return <Loading />;

  return (
    <div className="stack">
      <h1>Profile</h1>

      {!editing ? (
        <div className="card stack" data-testid="profile-view">
          <div className="row between">
            <span className="row" style={{ gap: 14 }}>
              <Avatar url={avatar} name={displayName} size={64} />
              <span className="stack" style={{ gap: 2 }}>
                <strong>{displayName}</strong>
                <span className="muted small">@{handle}</span>
                {email && <span className="muted small">{email}</span>}
              </span>
            </span>
            <button type="button" className="btn ghost sm" data-testid="profile-edit"
              onClick={() => setEditing(true)}>Edit</button>
          </div>
        </div>
      ) : (
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
        <div>
          <label className="field" htmlFor="em">Email <span className="muted small">(optional — for reminders & updates)</span></label>
          <input id="em" className="input" type="email" data-testid="profile-email" value={email}
            placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />
        </div>
        {error && <p className="err">{error}</p>}
        <div className="row">
          <button className="btn" data-testid="save-profile">Save</button>
          <button type="button" className="btn ghost sm" data-testid="profile-cancel"
            onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </form>
      )}

      <div className="card stack" data-testid="appearance">
        <div className="row between">
          <h3 style={{ margin: 0 }}>Appearance</h3>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className={`chip sm ${theme === "dark" ? "on" : ""}`}
              data-testid="theme-dark" onClick={() => { setTheme("dark"); applyTheme("dark"); }}>🌙 Dark</button>
            <button type="button" className={`chip sm ${theme === "light" ? "on" : ""}`}
              data-testid="theme-light" onClick={() => { setTheme("light"); applyTheme("light"); }}>☀️ Light</button>
          </div>
        </div>
      </div>

      <div className="card stack">
        <div className="row between">
          <h3 style={{ margin: 0 }}>Your availability</h3>
          {!editingAvail ? (
            <button type="button" className="btn ghost sm" data-testid="avail-edit"
              onClick={() => setEditingAvail(true)}>Edit availability</button>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className={mode === "weekly" ? "btn sm" : "btn ghost sm"}
                data-testid="avail-mode-weekly" onClick={() => setMode("weekly")}>Recurring weekly</button>
              <button type="button" className={mode === "specific" ? "btn sm" : "btn ghost sm"}
                data-testid="avail-mode-specific" onClick={() => setMode("specific")}>Specific dates</button>
            </div>
          )}
        </div>

        {!editingAvail && (
          <p className="muted small" data-testid="avail-readonly">
            {(mode === "weekly" ? week.size : free.size) === 0
              ? "You haven't set your availability yet. Tap Edit to add the times you're free — friends can see this."
              : "The times you're free (friends can see this). Tap Edit to change."}
          </p>
        )}

        {mode === "weekly" ? (
          <>
            {editingAvail && <p className="muted small">Tap the times you're usually free each week.</p>}
            <DayGrid dates={WEEK_ROWS} selected={week} cols={WEEK_PARTS} idPrefix="wk" readOnly={!editingAvail}
              onToggle={toggleWeekCell} onToggleRow={toggleWeekRow} onToggleCol={toggleWeekCol} testid="weekly-grid" />
          </>
        ) : (
          <>
            {editingAvail && <p className="muted small">Tap the times you're free on each date (tap a date or column header to fill it).</p>}
            <div className="row between" style={{ alignItems: "center" }}>
              <button type="button" className="btn ghost sm" data-testid="avail-earlier"
                disabled={pageOffset === 0} onClick={() => setPageOffset((o) => Math.max(0, o - PAGE))}>← Earlier</button>
              <span className="muted small" data-testid="avail-range">{dates[0].label} – {dates[dates.length - 1].label}</span>
              <button type="button" className="btn ghost sm" data-testid="avail-later"
                disabled={pageOffset >= MAX_OFFSET} onClick={() => setPageOffset((o) => Math.min(MAX_OFFSET, o + PAGE))}>Later →</button>
            </div>
            <DayGrid dates={dates} selected={free} busy={busyCells} readOnly={!editingAvail}
              onToggle={toggleCell} onToggleRow={toggleRow} onToggleCol={toggleCol} testid="availability-grid" />
          </>
        )}

        {editingAvail && (
          <div className="row">
            <button className="btn" data-testid={mode === "weekly" ? "save-weekly" : "save-availability"}
              onClick={() => (mode === "weekly" ? saveWeekly() : saveAvailability())}>Save availability</button>
            <button type="button" className="btn ghost sm" data-testid="avail-cancel" onClick={cancelAvail}>Cancel</button>
          </div>
        )}
      </div>

      <CalendarConnections />

      <Toast msg={savedMsg} onDone={() => setSavedMsg(null)} />
    </div>
  );
}
