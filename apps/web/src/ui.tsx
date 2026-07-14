import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";
import { Link } from "react-router-dom";
import { ApiFn, DAYPARTS, deferredInstall, getJSON, isIOS, useApi } from "./lib";
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

// Skeleton placeholders: on a first load, pages render their real chrome
// immediately and mark where data will land with these shimmer blocks
// (.skel in styles.css) instead of a bare "Loading…" wall.
export function Skel({ w, h = 14, r, style }: {
  w: number | string; h?: number; r?: number | string; style?: React.CSSProperties;
}) {
  return <span className="skel" aria-hidden style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

// A list page's placeholder: optional page-title bar + N tile-shaped cards.
export function ListSkeleton({ rows = 4, thumb = true, header = false }: {
  rows?: number; thumb?: boolean; header?: boolean;
}) {
  return (
    <div className="stack" data-testid="skeleton" aria-busy="true">
      {header && <Skel w="40%" h={30} style={{ margin: "0.4rem 0" }} />}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card row" style={{ gap: 12 }}>
          {thumb && <Skel w={56} h={56} r="var(--radius-sm)" style={{ flex: "none" }} />}
          <span style={{ flex: 1, display: "block" }}>
            <Skel w="55%" h={16} />
            <Skel w="35%" style={{ marginTop: 8 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

// The event page's placeholder: cover slot + title/meta lines + an RSVP-ish card.
export function EventSkeleton() {
  return (
    <div className="stack" data-testid="skeleton" aria-busy="true">
      <BackLink />
      <div className="card stack">
        <Skel w="100%" h={180} r="var(--radius-sm)" />
        <Skel w="60%" h={22} />
        <Skel w="40%" />
        <Skel w="50%" />
      </div>
      <div className="card stack">
        <Skel w="30%" h={16} />
        <Skel w="70%" h={38} r="var(--radius-sm)" />
      </div>
    </div>
  );
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
  onToggle, onToggleRow, onToggleCol, onPaint, paintOn, readOnly, testid,
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
  // SLIDE-TO-PAINT (When2meet-style): when provided, a press decides the
  // operation from the FIRST cell (in paintOn already? clear : set) and every
  // cell the finger/pointer crosses gets the same operation once. paintOn is
  // the set that defines "on" for that decision (the active brush's set on
  // Profile, the selected set on poll grids). Taps go through the same path.
  onPaint?: (day: string, dp: string, on: boolean) => void;
  paintOn?: Set<string>;
  readOnly?: boolean;
  testid?: string;
}) {
  const key = (day: string, dp: string) => `${day}:${dp}`;
  // One drag = one operation applied to each cell at most once.
  const drag = useRef<{ on: boolean; painted: Set<string> } | null>(null);
  const applyAt = (el: Element | null) => {
    if (!drag.current || !onPaint) return;
    const cell = (el as HTMLElement | null)?.closest?.("[data-day]") as HTMLElement | null;
    if (!cell || cell.hasAttribute("disabled")) return;
    const day = cell.dataset.day!;
    const dp = cell.dataset.dp!;
    const k = key(day, dp);
    if (drag.current.painted.has(k)) return;
    drag.current.painted.add(k);
    onPaint(day, dp, drag.current.on);
  };
  const paintHandlers = onPaint && !readOnly ? {
    onPointerDown: (e: React.PointerEvent) => {
      const cell = (e.target as HTMLElement).closest?.("[data-day]") as HTMLElement | null;
      if (!cell || cell.hasAttribute("disabled")) return;
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const k = key(cell.dataset.day!, cell.dataset.dp!);
      drag.current = { on: !(paintOn ?? free).has(k), painted: new Set() };
      applyAt(cell);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag.current) return;
      applyAt(document.elementFromPoint(e.clientX, e.clientY));
    },
    onPointerUp: () => { drag.current = null; },
    onPointerCancel: () => { drag.current = null; },
  } : {};
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
    <div className={`grid ${onPaint && !readOnly ? "paintable" : ""}`}
      style={{ gridTemplateColumns: `auto repeat(${cols.length}, 1fr)` }} data-testid={testid} {...paintHandlers}>
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
                data-day={d.value} data-dp={dp.value}
                className={cellClass(k)} disabled={isLocked} title={cellTitle(k)}
                aria-label={label} aria-pressed={free.has(k)}
                onClick={onPaint ? undefined : () => onToggle?.(d.value, dp.value)}
                onKeyDown={onPaint ? (ev) => {
                  if (ev.key !== "Enter" && ev.key !== " ") return;
                  ev.preventDefault();
                  onPaint(d.value, dp.value, !(paintOn ?? free).has(k));
                } : undefined} />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

// When2meet-style time grid for the 'dates' poll scope: the host's chosen days
// are COLUMNS, actual clock times (30-min slots) are ROWS. Paintable like
// DayGrid (drag to fill), but transposed so a long list of times scrolls
// vertically and days scroll horizontally on a phone. Doubles as the results
// heatmap: pass `counts`/`top` to color cells by how many people are free and
// `onCellClick` (instead of onPaint) so the host taps a cell to finalize it.
export function TimeGrid({
  days, slots, free, counts, top = 1, pick, fmtSlot, daysPerPage = 4,
  onPaint, paintOn, onToggleCol, onToggleRow, onCellClick, readOnly, testid, idPrefix = "tg",
}: {
  days: { value: string; label: string }[];
  slots: number[];
  free: Set<string>;
  counts?: Map<string, number>;
  top?: number;
  pick?: Set<string>;
  fmtSlot: (m: number) => string;
  // Days are COLUMNS; more than this many paginate (← Earlier / Later →) rather
  // than scrolling off-screen, which reads as "the grid just ends".
  daysPerPage?: number;
  onPaint?: (day: string, min: number, on: boolean) => void;
  paintOn?: Set<string>;
  onToggleCol?: (day: string) => void;
  onToggleRow?: (min: number) => void;
  onCellClick?: (day: string, min: number) => void;
  readOnly?: boolean;
  testid?: string;
  idPrefix?: string;
}) {
  const key = (day: string, min: number) => `${day}:${min}`;
  // Paginate the day columns so long date lists don't hide behind a horizontal
  // scroll. The `free`/`counts`/`pick` sets span ALL days, so painting or
  // picking across pages accumulates normally - only the viewport moves.
  const pages = Math.max(1, Math.ceil(days.length / daysPerPage));
  const [page, setPage] = useState(0);
  const p = Math.min(page, pages - 1);
  const pageDays = days.slice(p * daysPerPage, p * daysPerPage + daysPerPage);
  const drag = useRef<{ on: boolean; painted: Set<string> } | null>(null);
  const applyAt = (el: Element | null) => {
    if (!drag.current || !onPaint) return;
    const cell = (el as HTMLElement | null)?.closest?.("[data-day]") as HTMLElement | null;
    if (!cell || !cell.dataset.min) return;
    const k = key(cell.dataset.day!, Number(cell.dataset.min));
    if (drag.current.painted.has(k)) return;
    drag.current.painted.add(k);
    onPaint(cell.dataset.day!, Number(cell.dataset.min), drag.current.on);
  };
  const paintHandlers = onPaint && !readOnly ? {
    onPointerDown: (e: React.PointerEvent) => {
      const cell = (e.target as HTMLElement).closest?.("[data-day]") as HTMLElement | null;
      if (!cell || !cell.dataset.min) return;
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const k = key(cell.dataset.day!, Number(cell.dataset.min));
      drag.current = { on: !(paintOn ?? free).has(k), painted: new Set() };
      applyAt(cell);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag.current) return;
      applyAt(document.elementFromPoint(e.clientX, e.clientY));
    },
    onPointerUp: () => { drag.current = null; },
    onPointerCancel: () => { drag.current = null; },
  } : {};
  const heat = (n: number): React.CSSProperties =>
    n === 0 ? {} : { background: `rgba(238, 108, 77, ${0.18 + 0.82 * (n / top)})`, borderColor: "transparent", color: "#fff" };
  return (
    <div className="stack" style={{ gap: 6 }}>
      {pages > 1 && (
        <div className="row between" data-testid={`${idPrefix}-pager`}>
          <button type="button" className="btn ghost sm" data-testid={`${idPrefix}-earlier`}
            disabled={p === 0} onClick={() => setPage(p - 1)}>← Earlier</button>
          <span className="muted small" data-testid={`${idPrefix}-range`}>
            {pageDays[0]?.label} – {pageDays[pageDays.length - 1]?.label}
          </span>
          <button type="button" className="btn ghost sm" data-testid={`${idPrefix}-later`}
            disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Later →</button>
        </div>
      )}
      <div className={`grid ${onPaint && !readOnly ? "paintable" : ""}`}
        style={{ gridTemplateColumns: `auto repeat(${pageDays.length}, minmax(46px, 1fr))` }}
        data-testid={testid} {...paintHandlers}>
        <div />
        {pageDays.map((d) =>
          onToggleCol && !readOnly ? (
            <button key={d.value} type="button" className="hd gp-head" data-testid={`${idPrefix}-col-${d.value}`}
              aria-label={`Fill the whole ${d.label} column`} onClick={() => onToggleCol(d.value)}>{d.label}</button>
          ) : (
            <div key={d.value} className="hd">{d.label}</div>
          ),
        )}
        {slots.map((m) => (
          <Fragment key={m}>
            {onToggleRow && !readOnly ? (
              <button type="button" className="day gp-head" style={{ textAlign: "right", whiteSpace: "nowrap" }}
                data-testid={`${idPrefix}-row-${m}`} aria-label={`Fill ${fmtSlot(m)} across all days`}
                onClick={() => onToggleRow(m)}>{fmtSlot(m)}</button>
            ) : (
              <div className="day" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{fmtSlot(m)}</div>
            )}
            {pageDays.map((d) => {
              const k = key(d.value, m);
              const n = counts?.get(k) ?? 0;
              const label = `${d.label}, ${fmtSlot(m)}: ${counts ? `${n} free` : free.has(k) ? "free" : "not set"}`;
              const picked = pick?.has(k)
                ? { outline: "3px solid var(--accent)", outlineOffset: "-3px", position: "relative" as const, zIndex: 2 } : {};
              const base: React.CSSProperties = counts
                ? { ...heat(n), display: "grid", placeItems: "center", fontSize: "0.7rem", fontWeight: 700, cursor: onCellClick ? "pointer" : "default" }
                : {};
              return (
                <button key={d.value} type="button" data-testid={`${idPrefix}-cell-${d.value}-${m}`}
                  data-day={d.value} data-min={m}
                  className={`cell ${!counts && free.has(k) ? "on" : ""}`} title={label}
                  aria-label={label} aria-pressed={free.has(k)}
                  style={{ ...base, ...picked }}
                  onClick={onCellClick ? () => onCellClick(d.value, m) : onPaint ? undefined : undefined}
                  onKeyDown={onPaint && !readOnly ? (ev) => {
                    if (ev.key !== "Enter" && ev.key !== " ") return;
                    ev.preventDefault();
                    onPaint(d.value, m, !(paintOn ?? free).has(k));
                  } : undefined}>
                  {counts && n > 0 ? n : ""}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// A forward-only month calendar for multi-selecting specific days (the 'dates'
// poll scope). Past days are disabled; the host pages months forward as far as
// they like. Shared by the quick create flow and the full wizard.
export function MonthPicker({ selected, onToggle }: { selected: Set<string>; onToggle: (day: string) => void }) {
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const first = new Date(view.y, view.m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const ymd = (d: number) => `${view.y}-${String(view.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const atStart = view.y === today.getFullYear() && view.m === today.getMonth();
  const step = (dir: number) => setView((v) => {
    const d = new Date(v.y, v.m + dir, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const label = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return (
    <div className="card" style={{ padding: 10 }} data-testid="month-picker">
      <div className="row between" style={{ marginBottom: 6 }}>
        <button type="button" className="btn ghost sm" disabled={atStart} data-testid="cal-prev" onClick={() => step(-1)}>‹</button>
        <strong data-testid="cal-month">{label}</strong>
        <button type="button" className="btn ghost sm" data-testid="cal-next" onClick={() => step(1)}>›</button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="hd" style={{ textAlign: "center" }}>{d}</div>)}
        {Array.from({ length: startDow }, (_, i) => <div key={`b${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => {
          const v = ymd(d);
          const past = v < todayYmd;
          const on = selected.has(v);
          return (
            <button key={d} type="button" disabled={past} data-testid={`cal-day-${v}`}
              className={`cell ${on ? "on" : ""}`} aria-pressed={on}
              style={{ minHeight: 38, opacity: past ? 0.3 : 1, display: "grid", placeItems: "center" }}
              onClick={() => onToggle(v)}>{d}</button>
          );
        })}
      </div>
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

// Styled QR code for the invite link - the one image share that isn't a dead
// end: stories/flyers/screens get scanned straight into the RSVP page. The
// matrix comes from qrcode-generator (Reed-Solomon is not something to
// hand-roll); the styling - color + module shape - is ours, drawn on canvas.
// Error correction Q leaves headroom for the styling.
export type QRStyle = "squares" | "rounded" | "dots";
export function drawQR(url: string, color: string, style: QRStyle): string {
  const qr = qrcode(0, "Q");
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;                 // standard quiet zone, in modules
  const scale = 24;                // big modules -> crisp exports
  const S = (n + quiet * 2) * scale;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#ffffff";       // solid light background - scanability
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(color) ? color : "#1b1a22";
  // The three 7x7 finder squares stay near-solid regardless of style - they
  // are what scanners lock onto; data modules carry the chosen look.
  const inFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      const x = (c + quiet) * scale;
      const y = (r + quiet) * scale;
      if (style === "squares" || inFinder(r, c)) {
        ctx.beginPath();
        ctx.roundRect(x, y, scale, scale, inFinder(r, c) && style !== "squares" ? scale * 0.22 : 0);
        ctx.fill();
      } else if (style === "dots") {
        ctx.beginPath();
        ctx.arc(x + scale / 2, y + scale / 2, scale * 0.44, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, scale - 2, scale - 2, scale * 0.34);
        ctx.fill();
      }
    }
  }
  return canvas.toDataURL("image/png");
}

// Render plain text with working links: https URLs become clickable anchors
// (new tab, no referrer), everything else stays escaped text. Used for event
// descriptions and comments - "if people paste links they should work".
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
export function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="accent"
            style={{ textDecoration: "underline", overflowWrap: "anywhere" }}>{part}</a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

// One-time "add Whensdays to your home screen" prompt, shown right after a
// user creates their FIRST event on this device (the moment they became a
// host - peak motivation). Small screens only (a home screen is a phone
// concept; also keeps desktop E2E flows untouched), never when already
// installed. Android taps through to the NATIVE install dialog when the
// browser offered one; iOS gets the share-sheet steps.
// The exact glyphs iOS shows - recognition beats description.
function ShareGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
    </svg>
  );
}
function PlusGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 9v6M9 12h6" />
    </svg>
  );
}

// In-app browsers (Instagram/Facebook/TikTok/Twitter webviews) can't install
// PWAs at all - the only honest guidance is "open in your real browser".
function inAppBrowser(): boolean {
  return /Instagram|FBAN|FBAV|Twitter|TikTok|Snapchat|Line\//i.test(navigator.userAgent);
}

export function HomescreenPrompt({ onClose }: { onClose: () => void }) {
  const native = deferredInstall;
  return createPortal(
    <div className="crop-overlay" data-testid="a2hs-modal">
      <div className="card stack crop-card">
        <div style={{ fontSize: "2rem" }}>📲</div>
        <strong>Keep Whensdays one tap away</strong>
        <p className="muted small" style={{ margin: 0 }}>
          Your plans, RSVPs, and polls on your home screen - it opens like an app.
        </p>
        {!native && inAppBrowser() && (
          <p className="small" style={{ margin: 0 }}>
            This in-app browser can't install it - open <strong>whensdays.com</strong> in
            {isIOS() ? " Safari" : " your browser"} first (menu → open in browser).
          </p>
        )}
        {!native && !inAppBrowser() && isIOS() && (
          <div className="stack" style={{ gap: 10 }}>
            <span className="row" style={{ gap: 10 }}>
              <span className="a2hs-step">1</span>
              <ShareGlyph />
              <span className="small">Tap <strong>Share</strong> in the bar below</span>
            </span>
            <span className="row" style={{ gap: 10 }}>
              <span className="a2hs-step">2</span>
              <PlusGlyph />
              <span className="small">Scroll and tap <strong>Add to Home Screen</strong></span>
            </span>
          </div>
        )}
        {!native && !inAppBrowser() && !isIOS() && (
          <p className="small" style={{ margin: 0 }}>
            Open your browser menu (⋮) and choose <strong>"Add to Home screen"</strong>.
          </p>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {native && (
            <button type="button" className="btn sm" data-testid="a2hs-add"
              onClick={async () => { try { await native.prompt(); } catch { /* dismissed */ } onClose(); }}>
              Add to Home Screen
            </button>
          )}
          <button type="button" className="btn ghost sm" data-testid="a2hs-close" onClick={onClose}>
            {native ? "Maybe later" : "Got it"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Button + modal: a big theme-matched QR for the invite link - built for the
// in-person moment ("scan this") rather than export. One tap to show, big and
// high-contrast; the module color follows the event theme's accent (darkened
// for scanability), no customizer, no download ceremony.
export function QRButton({ url, accent, testid = "qr-open", label = "QR code" }: {
  url: string; accent?: string; testid?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  // Darken the accent toward ink: scanners want dark-on-light contrast.
  const color = (() => {
    const a = accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#1b1a22";
    const ch = (i: number) => Math.round(parseInt(a.slice(i, i + 2), 16) * 0.6);
    return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
  })();
  return (
    <>
      <button type="button" className="btn ghost sm" data-testid={testid}
        onClick={() => { analytics.capture(EVENTS.qrOpened); setOpen(true); }}>{label}</button>
      {open && createPortal(
        <div className="crop-overlay" data-testid="qr-modal" onClick={() => setOpen(false)}>
          <div className="card stack crop-card" onClick={(e) => e.stopPropagation()}>
            <strong>Scan to open the invite</strong>
            <img src={drawQR(url, color, "rounded")} alt="QR code for the invite link" data-testid="qr-img"
              style={{ width: "100%", borderRadius: 10 }} />
            <button type="button" className="btn ghost sm" data-testid="qr-close" onClick={() => setOpen(false)}>Close</button>
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
        <input className="input" maxLength={100} data-testid="gif-q" value={q}
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
      <input className="input" maxLength={200} data-testid={testid} value={value} placeholder={placeholder}
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
          {/* ODbL requires attribution wherever OSM-derived results render. */}
          <div className="addr-attrib">
            © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors
          </div>
        </div>
      )}
    </div>
  );
}
