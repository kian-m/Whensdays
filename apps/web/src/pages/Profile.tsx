import { useEffect, useRef, useState } from "react";
import {
  AvailabilityDay,
  AvailabilitySlot,
  Commitment,
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
  commitmentBusy,
  sendJSON,
  useApi,
  useProfile,
} from "../lib";
import { useSearchParams } from "react-router-dom";
import { AvailLegend, Avatar, DayGrid, Loading, Toast, fileToAvatar, useAsync } from "../ui";
import { DEV_AUTH } from "../App";
import { ClerkAccountCard } from "../ClerkAccount";
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
  // Which color a header-fill tap paints. Cells always toggle; the toggle just
  // flips whether "fill row/column" means mark-free or mark-busy.
  const [paintMode, setPaintMode] = useState<"free" | "busy">("free");
  const [editingAvail, setEditingAvail] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [pageOffset, setPageOffset] = useState(0);
  const dates = daysFrom(pageOffset, PAGE);

  // Each grid is tri-state: a cell is in `free` (green), `busy` (red), or neither
  // (unselected). The two sets are always disjoint — painting one clears the other.
  const [free, setFree] = useState<Set<string>>(new Set());
  const [dayBusy, setDayBusy] = useState<Set<string>>(new Set());
  const [week, setWeek] = useState<Set<string>>(new Set());
  const [weekBusy, setWeekBusy] = useState<Set<string>>(new Set());

  const asFree = (rows: { key: string; status?: string }[]) => new Set(rows.filter((r) => r.status !== "busy").map((r) => r.key));
  const asBusy = (rows: { key: string; status?: string }[]) => new Set(rows.filter((r) => r.status === "busy").map((r) => r.key));

  // Explicit date-based availability (the full set across all pages).
  const { data: availData, loading } = useAsync<{ days: AvailabilityDay[]; commitments: Commitment[] }>((a) => getJSON(a, "/api/availability/days"));
  const days = availData?.days;
  useEffect(() => {
    if (!days) return;
    const rows = days.map((d) => ({ key: `${d.day}:${d.daypart}`, status: d.status }));
    setFree(asFree(rows));
    setDayBusy(asBusy(rows));
  }, [days]);

  // Recurring weekly availability.
  const { data: slots } = useAsync<AvailabilitySlot[]>((a) => getJSON(a, "/api/availability"));
  useEffect(() => {
    if (!slots) return;
    const rows = slots.map((s) => ({ key: `${s.weekday}:${s.part_of_day}`, status: s.status }));
    setWeek(asFree(rows));
    setWeekBusy(asBusy(rows));
  }, [slots]);

  // Imported-calendar busy times lock cells in the specific-dates grid (read-only).
  const { data: cal } = useAsync<{ events: ImportedEvent[] }>((a) => getJSON(a, "/api/calendar/events"));
  // Locked (hatched, uneditable) cells = imported-calendar busy + your own
  // RSVP'd commitments — an RSVP automatically blocks your availability.
  const busyCells = new Set([
    ...importedBusy(cal?.events ?? []).cells,
    ...commitmentBusy(availData?.commitments ?? []),
  ]);

  function mutate(setter: typeof setFree, fn: (s: Set<string>) => void) {
    setter((prev) => {
      const next = new Set(prev);
      fn(next);
      return next;
    });
  }

  type Grid = {
    free: Set<string>; setFree: typeof setFree;
    busy: Set<string>; setBusy: typeof setFree;
    locked?: Set<string>;
  };

  // Tap a cell: paint it the active brush's color, or clear it if it already is.
  // In "busy" mode a tap can never turn a cell green (and vice-versa).
  function paintCell(g: Grid, k: string) {
    if (paintMode === "free") {
      if (g.free.has(k)) mutate(g.setFree, (s) => s.delete(k));
      else { mutate(g.setFree, (s) => s.add(k)); mutate(g.setBusy, (s) => s.delete(k)); }
    } else {
      if (g.busy.has(k)) mutate(g.setBusy, (s) => s.delete(k));
      else { mutate(g.setBusy, (s) => s.add(k)); mutate(g.setFree, (s) => s.delete(k)); }
    }
  }

  // Tap a row/date or column header: fill the whole line with the active brush,
  // or clear it if the line is already entirely that color. Locked cells are skipped.
  function paintLine(g: Grid, keys: string[]) {
    const cells = keys.filter((k) => !g.locked?.has(k));
    if (paintMode === "free") {
      if (cells.every((k) => g.free.has(k))) mutate(g.setFree, (s) => cells.forEach((k) => s.delete(k)));
      else { mutate(g.setFree, (s) => cells.forEach((k) => s.add(k))); mutate(g.setBusy, (s) => cells.forEach((k) => s.delete(k))); }
    } else {
      if (cells.every((k) => g.busy.has(k))) mutate(g.setBusy, (s) => cells.forEach((k) => s.delete(k)));
      else { mutate(g.setBusy, (s) => cells.forEach((k) => s.add(k))); mutate(g.setFree, (s) => cells.forEach((k) => s.delete(k))); }
    }
  }

  const dateGrid: Grid = { free, setFree, busy: dayBusy, setBusy: setDayBusy, locked: busyCells };
  const weekGrid: Grid = { free: week, setFree: setWeek, busy: weekBusy, setBusy: setWeekBusy };

  // --- explicit-date grid handlers ---
  const toggleCell = (day: string, dp: string) => paintCell(dateGrid, `${day}:${dp}`);
  const toggleRow = (day: string) => paintLine(dateGrid, DAYPARTS.map((dp) => `${day}:${dp.value}`));
  const toggleCol = (dp: string) => paintLine(dateGrid, dates.map((d) => `${d.value}:${dp}`));

  // --- weekly grid handlers (keyed "weekday:part") ---
  const toggleWeekCell = (wd: string, dp: string) => paintCell(weekGrid, `${wd}:${dp}`);
  const toggleWeekRow = (wd: string) => paintLine(weekGrid, WEEK_PARTS.map((p) => `${wd}:${p.value}`));
  const toggleWeekCol = (dp: string) => paintLine(weekGrid, WEEK_ROWS.map((r) => `${r.value}:${dp}`));

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
    const res = await sendJSON(api, "PUT", "/api/profile", { display_name: displayName, handle });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setError(b.error || "could not save");
    }
    onUpdated(await res.json());
    setSavedMsg("Profile saved ✓");
    setEditing(false);
  }

  async function saveAvailability() {
    const payload = [
      ...[...free].map((k) => { const [day, daypart] = k.split(":"); return { day, daypart, status: "free" }; }),
      ...[...dayBusy].map((k) => { const [day, daypart] = k.split(":"); return { day, daypart, status: "busy" }; }),
    ];
    await sendJSON(api, "PUT", "/api/availability/days", { days: payload });
    setSavedMsg("Availability saved ✓");
    setEditingAvail(false);
  }

  async function saveWeekly() {
    const slotsPayload = [
      ...[...week].map((k) => { const [wd, part_of_day] = k.split(":"); return { weekday: Number(wd), part_of_day, status: "free" }; }),
      ...[...weekBusy].map((k) => { const [wd, part_of_day] = k.split(":"); return { weekday: Number(wd), part_of_day, status: "busy" }; }),
    ];
    await sendJSON(api, "PUT", "/api/availability", { slots: slotsPayload });
    setSavedMsg("Availability saved ✓");
    setEditingAvail(false);
  }

  // Discard edits: restore both grids from the last-loaded server data.
  function cancelAvail() {
    if (days) {
      const rows = days.map((d) => ({ key: `${d.day}:${d.daypart}`, status: d.status }));
      setFree(asFree(rows));
      setDayBusy(asBusy(rows));
    }
    if (slots) {
      const rows = slots.map((sl) => ({ key: `${sl.weekday}:${sl.part_of_day}`, status: sl.status }));
      setWeek(asFree(rows));
      setWeekBusy(asBusy(rows));
    }
    setEditingAvail(false);
  }

  if (loading && !availData) return <Loading />;

  return (
    <div className="stack">
      <h1>Profile</h1>
      {!DEV_AUTH && <ClerkAccountCard />}

      {!editing ? (
        <div className="card stack" data-testid="profile-view">
          <div className="row between">
            <span className="row" style={{ gap: 14 }}>
              <Avatar url={avatar} name={displayName} size={64} />
              <span className="stack" style={{ gap: 2 }}>
                <strong>{displayName}</strong>
                <span className="muted small">@{handle}</span>
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
            {(mode === "weekly" ? week.size + weekBusy.size : free.size + dayBusy.size) === 0
              ? "You haven't set your availability yet. Tap Edit, then mark when you're free (green) or busy (red) — friends can see this."
              : "Green is when you're free, red is when you're busy, blank is unset (friends can see this). Tap Edit to change."}
          </p>
        )}

        {editingAvail && (
          <div className="row" style={{ gap: 8, alignItems: "center" }} data-testid="paint-toggle">
            <span className="muted small">Tap to mark cells as:</span>
            <button type="button" className={`chip sm ${paintMode === "free" ? "on" : ""}`}
              data-testid="paint-free" onClick={() => setPaintMode("free")}>🟩 Free</button>
            <button type="button" className={`chip sm ${paintMode === "busy" ? "on" : ""}`}
              data-testid="paint-busy" onClick={() => setPaintMode("busy")}>🟥 Busy</button>
          </div>
        )}

        {mode === "weekly" ? (
          <>
            {editingAvail && <p className="muted small">Tap a cell to mark it {paintMode}; tap again to clear it. A row/column header fills the whole line.</p>}
            <DayGrid dates={WEEK_ROWS} free={week} busy={weekBusy} cols={WEEK_PARTS} idPrefix="wk" readOnly={!editingAvail}
              onToggle={toggleWeekCell} onToggleRow={toggleWeekRow} onToggleCol={toggleWeekCol} testid="weekly-grid" />
          </>
        ) : (
          <>
            {editingAvail && <p className="muted small">Tap a cell to mark it {paintMode}; tap again to clear it. A date/column header fills the whole line.</p>}
            <div className="row between" style={{ alignItems: "center" }}>
              <button type="button" className="btn ghost sm" data-testid="avail-earlier"
                disabled={pageOffset === 0} onClick={() => setPageOffset((o) => Math.max(0, o - PAGE))}>← Earlier</button>
              <span className="muted small" data-testid="avail-range">{dates[0].label} – {dates[dates.length - 1].label}</span>
              <button type="button" className="btn ghost sm" data-testid="avail-later"
                disabled={pageOffset >= MAX_OFFSET} onClick={() => setPageOffset((o) => Math.min(MAX_OFFSET, o + PAGE))}>Later →</button>
            </div>
            <DayGrid dates={dates} free={free} busy={dayBusy} locked={busyCells} readOnly={!editingAvail}
              onToggle={toggleCell} onToggleRow={toggleRow} onToggleCol={toggleCol} testid="availability-grid" />
          </>
        )}

        <AvailLegend hasCalendar={mode === "specific" && busyCells.size > 0} />

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
