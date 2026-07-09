import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ApiFn, DAYPARTS, getJSON, useApi } from "./lib";
import { EVENTS, analytics } from "./analytics";

// Small data-loading hook with STALE-WHILE-REVALIDATE: the last successful
// result for each call site is kept in a session-lived cache, so returning to a
// page renders instantly from cache while a background refetch updates it in
// place. Every mount still refetches - nothing is served stale-only, so no
// invalidation bookkeeping is needed; a full page load starts fresh.
// Cache key = the fetcher's source + deps (closure source is stable per call
// site; deps carry the ids that vary, e.g. the event id).
const swrCache = new Map<string, unknown>();

export function useAsync<T>(fn: (api: ApiFn) => Promise<T>, deps: unknown[] = []) {
  const api = useApi();
  const key = fn.toString() + "|" + JSON.stringify(deps);
  const cached = swrCache.get(key) as T | undefined;
  const [data, setData] = useState<T | null>(cached ?? null);
  // Only show a loading state when there's nothing cached to render.
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    if (swrCache.get(key) === undefined) setLoading(true);
    fn(api)
      .then((d) => {
        swrCache.set(key, d);
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Route changes remount with different deps/key: swap to that key's cache
  // (or null) immediately, then revalidate.
  useEffect(() => {
    const c = swrCache.get(key) as T | undefined;
    setData(c ?? null);
    setLoading(c === undefined);
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

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

// Two-tap destructive confirmation - native confirm() dialogs are silently
// suppressed on iOS (especially installed-PWA standalone mode), so "Cancel
// event" did nothing on phones. First tap arms the button (auto-disarms after
// 4s); the second tap actually fires.
export function ConfirmButton({ label, confirmLabel, onConfirm, testid }: {
  label: string; confirmLabel: string; onConfirm: () => void | Promise<void>; testid: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className="btn ghost sm" data-testid={testid}
      style={{
        color: "var(--no)",
        ...(armed ? { background: "color-mix(in srgb, var(--no) 16%, transparent)", borderColor: "var(--no)", fontWeight: 700 } : {}),
      }}
      onClick={() => { if (armed) { setArmed(false); void onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : label}
    </button>
  );
}

// Availability grid: rows = dates, columns = the 6 dayparts. Editable (tap a
// cell; tap a date or daypart header to fill that row/column) or read-only.
// `selected` and `busy` are sets of "YYYY-MM-DD:daypart" keys.
// A toggle grid of rows (dates or weekdays) × columns (time-of-day buckets).
// Defaults to the 6 DAYPARTS / "avail" test ids (explicit date availability);
// pass `cols`/`idPrefix` to reuse it for the recurring weekly grid.
// Cells are tri-state: `free` (green), `busy` (red, user-marked), or neither
// (neutral gray = unselected). `locked` cells come from an imported calendar -
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
            aria-label={`Fill the whole ${dp.value.replaceAll("_", " ")} column`}
            data-testid={`${idPrefix}-col-${dp.value}`} onClick={() => onToggleCol?.(dp.value)}>{dp.short}</button>
        ),
      )}
      {dates.map((d, i) => (
        <Fragment key={d.value}>
          {readOnly ? (
            <div className="day" style={{ textAlign: "left" }}>{d.label}</div>
          ) : (
            <button type="button" className="day gp-head" style={{ textAlign: "left" }}
              aria-label={`Fill the whole ${d.label} row`}
              data-testid={`${idPrefix}-row-${i}`} onClick={() => onToggleRow?.(d.value)}>{d.label}</button>
          )}
          {cols.map((dp) => {
            const k = key(d.value, dp.value);
            const isLocked = locked?.has(k);
            const label = `${d.label}, ${dp.value.replaceAll("_", " ")}: ${cellTitle(k)}`;
            return readOnly ? (
              <div key={dp.value} className={cellClass(k)} title={cellTitle(k)} role="img" aria-label={label} />
            ) : (
              <button key={dp.value} type="button" data-testid={`${idPrefix}-cell-${i}-${dp.value}`}
                className={cellClass(k)} disabled={isLocked} title={cellTitle(k)}
                aria-label={label} aria-pressed={free.has(k)}
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

// Resize an image File to a small square JPEG data URL (auto center-crop),
// client-side - keeps images tiny so they can live as data URLs in the DB (no
// object store). Used for group icons; avatars and event covers go through
// CropModal so the user picks the crop themselves.
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

// Client-rendered 1080x1080 share card (lock celebration, group streaks) -
// a canvas-composited PNG people can drop straight into stories/group chats.
// Pure canvas, no deps; the brand look mirrors the OG card.
export type ShareCardOpts = { kicker: string; emoji?: string; title: string; sub: string; accent?: string };
export function drawShareCard(o: ShareCardOpts): string {
  const S = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const accent = /^#[0-9a-f]{6}$/i.test(o.accent ?? "") ? o.accent! : "#ee6c4d";
  // Dusk gradient + an accent glow low in the frame (the sunset-through-glass palette).
  const bg = ctx.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, "#182338");
  bg.addColorStop(1, "#0d1322");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);
  const glow = ctx.createRadialGradient(S / 2, S * 0.85, 40, S / 2, S * 0.85, S * 0.95);
  glow.addColorStop(0, accent + "66");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);
  const sans = "-apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "center";
  // Kicker: uppercase micro-type, accent (the .pill language).
  ctx.fillStyle = accent;
  ctx.font = `800 40px ${sans}`;
  ctx.fillText(o.kicker.toUpperCase().split("").join("  "), S / 2, 220);
  if (o.emoji) {
    ctx.font = `160px ${sans}`;
    ctx.fillText(o.emoji, S / 2, 430);
  }
  // Title: display-weight, wrapped to at most 3 lines.
  ctx.fillStyle = "#f6f2ec";
  ctx.font = `800 88px ${sans}`;
  const words = o.title.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (ctx.measureText(probe).width > S - 160 && line) {
      lines.push(line);
      line = w;
      if (lines.length === 3) break;
    } else line = probe;
  }
  if (lines.length < 3 && line) lines.push(line);
  const titleTop = o.emoji ? 560 : 460;
  lines.forEach((l, i) => ctx.fillText(l, S / 2, titleTop + i * 104));
  // Sub: the date / group line.
  ctx.fillStyle = "rgba(246, 242, 236, 0.72)";
  ctx.font = `500 48px ${sans}`;
  ctx.fillText(o.sub, S / 2, titleTop + lines.length * 104 + 40);
  // Brand footer.
  ctx.fillStyle = "rgba(246, 242, 236, 0.55)";
  ctx.font = `700 38px ${sans}`;
  ctx.fillText("whensdays.com", S / 2, S - 90);
  return canvas.toDataURL("image/png");
}

// Button + preview modal for a share card: tap to render, then native-share
// (where the Web Share API takes files - iOS/Android), download, or close.
export function ShareCardButton({ card, label, testid }: {
  card: () => ShareCardOpts; label: string; testid: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  async function nativeShare() {
    if (!url) return;
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], "whensdays.png", { type: "image/png" });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        analytics.capture(EVENTS.shareCardShared, { kind: testid });
      }
    } catch { /* user closed the sheet */ }
  }
  return (
    <>
      <button type="button" className="btn ghost sm" data-testid={testid}
        onClick={() => { analytics.capture(EVENTS.shareCardOpened, { kind: testid }); setUrl(drawShareCard(card())); }}>{label}</button>
      {url && createPortal(
        <div className="crop-overlay" data-testid="share-card-modal">
          <div className="card stack crop-card">
            <img src={url} alt="share card preview" data-testid="share-card-img"
              style={{ width: "100%", borderRadius: 10 }} />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {"share" in navigator && (
                <button type="button" className="btn sm" data-testid="share-card-share" onClick={nativeShare}>Share</button>
              )}
              <a className="btn ghost sm" download="whensdays.png" href={url} data-testid="share-card-download">Download</a>
              <button type="button" className="btn ghost sm" data-testid="share-card-close" onClick={() => setUrl(null)}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// Downscale an image File preserving aspect (max side maxDim) to a JPEG data
// URL - comment photo attachments (square-cropping chat photos would butcher
// them, so no CropModal here).
export function fileToPhoto(file: File, maxDim = 640): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => reject(new Error("bad image"));
    img.src = URL.createObjectURL(file);
  });
}

// Pan-and-zoom crop dialog for uploaded photos. The square viewport IS the
// crop area: drag to position, slider to zoom; output is a size x size JPEG
// data URL (same contract as fileToAvatar). `shape` only changes the preview
// mask - avatars render as circles in the app, event covers as squares - the
// exported image is always the full square.
export function CropModal({ file, shape, size, onDone, onCancel }: {
  file: File; shape: "circle" | "square"; size: number;
  onDone: (dataUrl: string) => void; onCancel: () => void;
}) {
  const VIEW = 280;
  const [src, setSrc] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { setDims({ w: img.width, h: img.height }); setSrc(url); };
    img.onerror = () => onCancel();
    img.src = url;
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  if (!src || !dims) return null;

  // Baseline scale = "cover" (short side fills the viewport); zoom multiplies
  // it, and the pan offset is clamped so the image always covers the crop.
  const scale = (VIEW / Math.min(dims.w, dims.h)) * zoom;
  const dw = dims.w * scale, dh = dims.h * scale;
  const clampOff = (v: number, span: number) =>
    Math.min(Math.max(v, -(span - VIEW) / 2), (span - VIEW) / 2);
  const ox = clampOff(off.x, dw), oy = clampOff(off.y, dh);
  const left = (VIEW - dw) / 2 + ox, top = (VIEW - dh) / 2 + oy;

  function exportCrop() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx || !imgRef.current) return onCancel();
    ctx.drawImage(imgRef.current, -left / scale, -top / scale, VIEW / scale, VIEW / scale, 0, 0, size, size);
    onDone(canvas.toDataURL("image/jpeg", 0.85));
  }

  // Portal to <body>: .card's backdrop-filter makes it the containing block
  // for position:fixed descendants, so rendered in place the overlay would be
  // trapped inside (and painted under) sibling cards.
  return createPortal(
    <div className="crop-overlay" data-testid="crop-modal">
      <div className="card stack crop-card">
        <strong>{shape === "circle" ? "Position your photo" : "Crop your cover"}</strong>
        <span className="muted small">Drag to move · slide to zoom</span>
        <div
          className={`crop-viewport ${shape === "circle" ? "crop-circle" : ""}`}
          data-testid="crop-viewport"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, ox, oy };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            setOff({ x: drag.current.ox + e.clientX - drag.current.px, y: drag.current.oy + e.clientY - drag.current.py });
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <img ref={imgRef} className="crop-img" src={src} alt="" draggable={false}
            style={{ left, top, width: dw, height: dh }} />
          {shape === "circle" && <div className="crop-mask" aria-hidden />}
        </div>
        <input type="range" data-testid="crop-zoom" aria-label="Zoom" min={1} max={4} step={0.01}
          value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost sm" data-testid="crop-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn sm" data-testid="crop-save" onClick={exportCrop}>Use photo</button>
        </div>
      </div>
    </div>,
    document.body
  );
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

// Klipy GIF picker (server-proxied - the API key never reaches the browser).
// Trending shows on open, search filters as you type, and "Load more" pages
// through Klipy's cursor. Hidden entirely when the integration is unconfigured.
type KlipyGif = { url: string; preview: string; title: string };
type GifResp = { enabled: boolean; gifs: KlipyGif[]; next?: string };

export function GifPicker({ onPick }: { onPick: (url: string) => void }) {
  const api = useApi();
  const [enabled, setEnabled] = useState(false);
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState<KlipyGif[]>([]);
  const [next, setNext] = useState("");
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gridRef = useRef<HTMLDivElement>(null);

  // On open: an empty query returns trending AND doubles as the capability probe.
  useEffect(() => {
    getJSON<GifResp>(api, "/api/gifs/search")
      .then((b) => { setEnabled(b.enabled); if (b.enabled) { setGifs(b.gifs); setNext(b.next ?? ""); } })
      .catch(() => {});
  }, [api]);

  const fetchGifs = useCallback(async (query: string, pos = "") => {
    setLoading(true);
    try {
      const url = `/api/gifs/search?q=${encodeURIComponent(query)}${pos ? `&pos=${encodeURIComponent(pos)}` : ""}`;
      const b = await getJSON<GifResp>(api, url);
      if (pos) {
        setGifs((prev) => [...prev, ...b.gifs]); // append on "load more"
      } else {
        setGifs(b.gifs); // a fresh search replaces the list - scroll back to the top
        gridRef.current?.scrollTo({ top: 0 });
      }
      setNext(b.next ?? "");
    } finally {
      setLoading(false);
    }
  }, [api]);

  function onType(v: string) {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => fetchGifs(v.trim()), 350); // empty → trending
  }
  function searchNow() {
    if (debounce.current) clearTimeout(debounce.current);
    fetchGifs(q.trim());
  }

  if (!enabled) return null;

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <input className="input" data-testid="gif-q" value={q}
          placeholder="Search GIFs, or scroll the trending picks"
          onChange={(ev) => onType(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); searchNow(); } }} />
        <button type="button" className="btn soft sm" data-testid="gif-go" disabled={loading} onClick={searchNow}>
          {loading ? "…" : "Search"}
        </button>
      </div>
      {gifs.length > 0 && (
        <>
          <div className="gif-grid" data-testid="gif-grid" ref={gridRef}>
            {gifs.map((g, i) => (
              <button key={`${g.url}-${i}`} type="button" data-testid={`gif-${i}`} title={g.title}
                onClick={() => { analytics.capture(EVENTS.gifPicked); onPick(g.url); setGifs([]); setNext(""); }}>
                <img src={g.preview} alt={g.title} loading="lazy" />
              </button>
            ))}
          </div>
          {next && (
            <button type="button" className="btn ghost sm" style={{ alignSelf: "center" }}
              data-testid="gif-more" disabled={loading} onClick={() => fetchGifs(q.trim(), next)}>
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Address field with free type-ahead (proxied through /api/geo/search → Photon/
// OpenStreetMap; no key, no billing). Debounced; picking a suggestion fills the
// field. Falls back to a plain text box if the lookup returns nothing.
export function AddressInput({ value, onChange, placeholder, testid }: {
  value: string; onChange: (v: string) => void; placeholder?: string; testid?: string;
}) {
  const api = useApi();
  const [results, setResults] = useState<{ label: string }[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function query(v: string) {
    onChange(v);
    if (timer.current) clearTimeout(timer.current);
    // Suggestions only for street-address-shaped input (starts with a number,
    // e.g. "123 Main"). Venue names / free text stay a plain text box.
    if (v.trim().length < 3 || !/^\d/.test(v.trim())) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const b = await getJSON<{ results: { label: string }[] }>(
          api, `/api/geo/search?q=${encodeURIComponent(v.trim())}`);
        setResults(b.results);
        setOpen(b.results.length > 0);
      } catch { setResults([]); }
    }, 250);
  }

  return (
    <div style={{ position: "relative" }}>
      <input className="input" data-testid={testid} value={value} placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => query(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && results.length > 0 && (
        <div className="addr-menu" data-testid="addr-menu">
          {results.map((r, i) => (
            <button key={i} type="button" className="addr-item" data-testid={`addr-opt-${i}`}
              onMouseDown={(e) => { e.preventDefault(); onChange(r.label); setOpen(false); setResults([]); }}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
