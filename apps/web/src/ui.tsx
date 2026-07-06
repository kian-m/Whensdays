import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiFn, DAYPARTS, getJSON, useApi } from "./lib";
import { EVENTS, analytics } from "./analytics";

// Small data-loading hook: runs `fn` on mount and exposes a reload().
export function useAsync<T>(fn: (api: ApiFn) => Promise<T>, deps: unknown[] = []) {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setLoading(true);
    fn(api)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(run, [run]);
  return { data, loading, error, reload: run };
}

export function Loading() {
  return <p className="muted" style={{ marginTop: "2rem" }}>Loading…</p>;
}

export function BackLink() {
  return (
    <Link to="/" className="muted small" style={{ display: "inline-block", marginBottom: "0.6rem" }}>
      ← All events
    </Link>
  );
}

export function Pill({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

// Availability grid: rows = dates, columns = the 6 dayparts. Editable (tap a
// cell; tap a date or daypart header to fill that row/column) or read-only.
// `selected` and `busy` are sets of "YYYY-MM-DD:daypart" keys.
// A toggle grid of rows (dates or weekdays) × columns (time-of-day buckets).
// Defaults to the 6 DAYPARTS / "avail" test ids (explicit date availability);
// pass `cols`/`idPrefix` to reuse it for the recurring weekly grid.
// Cells are tri-state: `free` (green), `busy` (red, user-marked), or neither
// (neutral gray = unselected). `locked` cells come from an imported calendar —
// hatched red and non-interactive (you can't edit what your calendar says).
export function DayGrid({
  dates, free, busy, locked, cols = DAYPARTS, idPrefix = "avail",
  onToggle, onToggleRow, onToggleCol, readOnly, testid,
}: {
  dates: { value: string; label: string }[];
  free: Set<string>;
  busy?: Set<string>;
  locked?: Set<string>;
  cols?: { value: string; short: string }[];
  idPrefix?: string;
  onToggle?: (day: string, dp: string) => void;
  onToggleRow?: (day: string) => void;
  onToggleCol?: (dp: string) => void;
  readOnly?: boolean;
  testid?: string;
}) {
  const key = (day: string, dp: string) => `${day}:${dp}`;
  const cellClass = (k: string) => {
    if (locked?.has(k)) return "cell locked";
    if (free.has(k)) return "cell on";
    if (busy?.has(k)) return "cell busy-mark";
    return "cell";
  };
  const cellTitle = (k: string) => {
    if (locked?.has(k)) return "busy (from your calendar)";
    if (free.has(k)) return "free";
    if (busy?.has(k)) return "busy";
    return "not set";
  };
  return (
    <div className="grid" style={{ gridTemplateColumns: `auto repeat(${cols.length}, 1fr)` }} data-testid={testid}>
      <div />
      {cols.map((dp) =>
        readOnly ? (
          <div key={dp.value} className="hd">{dp.short}</div>
        ) : (
          <button key={dp.value} type="button" className="hd gp-head"
            data-testid={`${idPrefix}-col-${dp.value}`} onClick={() => onToggleCol?.(dp.value)}>{dp.short}</button>
        ),
      )}
      {dates.map((d, i) => (
        <Fragment key={d.value}>
          {readOnly ? (
            <div className="day" style={{ textAlign: "left" }}>{d.label}</div>
          ) : (
            <button type="button" className="day gp-head" style={{ textAlign: "left" }}
              data-testid={`${idPrefix}-row-${i}`} onClick={() => onToggleRow?.(d.value)}>{d.label}</button>
          )}
          {cols.map((dp) => {
            const k = key(d.value, dp.value);
            const isLocked = locked?.has(k);
            return readOnly ? (
              <div key={dp.value} className={cellClass(k)} title={cellTitle(k)} />
            ) : (
              <button key={dp.value} type="button" data-testid={`${idPrefix}-cell-${i}-${dp.value}`}
                className={cellClass(k)} disabled={isLocked} title={cellTitle(k)}
                onClick={() => onToggle?.(d.value, dp.value)} />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

// Color key for the tri-state availability grid. Rendered under every grid
// (your own + a friend's) so the three states are self-explanatory.
export function AvailLegend({ hasCalendar }: { hasCalendar?: boolean }) {
  return (
    <div className="legend" data-testid="avail-legend">
      <span className="sw"><i style={{ background: "var(--go)" }} /> Free</span>
      <span className="sw"><i style={{ background: "var(--no)" }} /> Busy</span>
      <span className="sw"><i style={{ background: "var(--line)" }} /> Not set</span>
      {hasCalendar && (
        <span className="sw"><i className="cell locked" style={{ height: 15, borderRadius: 4 }} /> From your calendar</span>
      )}
    </div>
  );
}

// Resize an image File to a small square JPEG data URL (cover crop), client-side
// — keeps images tiny so they can live as data URLs in the DB (no object store).
// Used for profile avatars and group icons.
export function fileToAvatar(file: File, size = 160): Promise<string> {
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

// Auto-dismissing confirmation toast (prominent + mobile-visible). Renders
// nothing when msg is empty; call onDone after it fades to clear the message.
export function Toast({ msg, onDone }: { msg: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [msg, onDone]);
  if (!msg) return null;
  return <div className="toast" data-testid="toast" role="status">{msg}</div>;
}

// Round avatar: shows the photo if present, otherwise a colored initial.
export function Avatar({ url, name, size = 36 }: { url?: string | null; name?: string | null; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.42 } as React.CSSProperties;
  if (url) return <img className="avatar" style={style} src={url} alt={name ?? ""} data-testid="avatar-img" />;
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  return <span className="avatar avatar-fallback" style={style} aria-hidden>{initial}</span>;
}

// Event tile thumbnail: the cover photo/GIF is the main visual when set;
// otherwise the type-colored emoji square. Shared by Home, Discover and Groups.
export function EventThumb({ photo, emoji, color, size = 46 }: {
  photo?: string; emoji: string; color: string; size?: number;
}) {
  if (photo) {
    return <img className="thumb" data-testid="event-thumb" src={photo} alt=""
      style={{ width: size, height: size }} loading="lazy" />;
  }
  return (
    <div className="emoji" style={{ width: size, height: size, fontSize: size * 0.52, display: "grid", placeItems: "center", background: `${color}22`, flex: "none" }}>
      {emoji}
    </div>
  );
}

// Klipy GIF search (server-proxied — the API key never reaches the browser).
// Hidden entirely when the server reports the integration unconfigured.
export function GifPicker({ onPick }: { onPick: (url: string) => void }) {
  const api = useApi();
  const [enabled, setEnabled] = useState(false);
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState<{ url: string; preview: string; title: string }[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    getJSON<{ enabled: boolean }>(api, "/api/gifs/search").then((b) => setEnabled(b.enabled)).catch(() => {});
  }, [api]);
  if (!enabled) return null;

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const b = await getJSON<{ gifs: { url: string; preview: string; title: string }[] }>(
        api, `/api/gifs/search?q=${encodeURIComponent(q.trim())}`);
      setGifs(b.gifs);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <input className="input" data-testid="gif-q" value={q} placeholder="…or search GIFs (Klipy)"
          onChange={(ev) => setQ(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); search(); } }} />
        <button type="button" className="btn soft sm" data-testid="gif-go" disabled={searching} onClick={search}>
          {searching ? "…" : "Search"}
        </button>
      </div>
      {gifs.length > 0 && (
        <div className="gif-grid" data-testid="gif-grid">
          {gifs.map((g, i) => (
            <button key={g.url} type="button" data-testid={`gif-${i}`} title={g.title}
              onClick={() => { analytics.capture(EVENTS.gifPicked); onPick(g.url); setGifs([]); }}>
              <img src={g.preview} alt={g.title} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
