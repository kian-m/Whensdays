import { createContext, useContext } from "react";

// --- shared domain types (mirror the Go API JSON) ---

export type EventType = "dinner" | "drinks" | "movie" | "camping" | "party" | "trip" | "show" | "practice" | "openmic" | "other";

export type Event = {
  id: string;
  host_id: string;
  title: string;
  event_type: EventType;
  description: string;
  location_mode: "host_place" | "find_venue" | "virtual";
  location_address: string;
  scheduling_mode: "fixed" | "poll" | "general";
  starts_at: string | null;
  status: "polling" | "scheduled" | "cancelled" | "draft";
  comments_enabled: boolean;
  group_id: string | null;
  series_id: string | null;
  recurrence: "" | "weekly" | "biweekly" | "monthly";
  visibility: "private" | "friends" | "public";
  topic: string;
  city: string;
  custom_emoji: string;
  custom_label: string;
  general_scope: "week" | "month" | "general" | "dates";
  photo_url: string;
  theme: string;
  timezone: string;
  ends_at: string | null;
  poll_deadline: string | null;
  capacity: number;
  created_at: string;
};

// Preset event-page backdrop themes (server-validated; see eventThemes in gifs.go).
export const EVENT_THEMES: { value: string; label: string }[] = [
  { value: "", label: "None" },
  { value: "party", label: "🎉 Party" },
  { value: "beach", label: "🏖️ Beach" },
  { value: "forest", label: "🌲 Forest" },
  { value: "night", label: "🌙 Night" },
  { value: "neon", label: "🪩 Neon" },
  { value: "cozy", label: "🕯️ Cozy" },
];

// A public event as shown on Discover/Feed (only host-published fields).
export type PublicEvent = {
  id: string;
  title: string;
  event_type: EventType;
  starts_at: string;
  topic: string;
  city: string;
  host_id: string;
  host_name: string | null;
  host_avatar: string | null;
  friends_going: number;
  viewer_rsvp: string;
  from_friend: boolean;
  custom_emoji: string;
  custom_label: string;
  photo_url: string;
  theme: string;
};

// Friendly per-type accent for event tiles (left edge + emoji tint).
// One ramp around the wheel at matched chroma/lightness so tiles feel like a
// set: warm types (food/social) advance, cool types (logistics) recede.
export const TYPE_COLORS: Record<EventType, string> = {
  dinner: "#e07a3f",
  drinks: "#9d6bd4",
  movie: "#d45f93",
  camping: "#3f9d6f",
  party: "#e0559b",
  trip: "#3d9db1",
  show: "#d05c5c",
  practice: "#5b83d6",
  openmic: "#c99a2e",
  other: "#8b8794",
};
export type Follow = { kind: "host" | "topic"; value: string };

// Discovery categories - the ONLY topics allowed (server-enforced, ranking.go).
export const CATEGORIES: { slug: string; label: string; emoji: string }[] = [
  { slug: "gaming", label: "Gaming", emoji: "🎮" },
  { slug: "streams", label: "Streams & shows", emoji: "📺" },
  { slug: "sports", label: "Sports & fitness", emoji: "🏃" },
  { slug: "tabletop", label: "Tabletop & RPGs", emoji: "🎲" },
  { slug: "books", label: "Books & learning", emoji: "📚" },
  { slug: "music", label: "Music & nightlife", emoji: "🎵" },
  { slug: "food-drink", label: "Food & drink", emoji: "🍜" },
  { slug: "outdoors", label: "Outdoors & travel", emoji: "🌲" },
  { slug: "arts", label: "Arts & crafts", emoji: "🎨" },
  { slug: "performance", label: "Comedy & performance", emoji: "🎭" },
  { slug: "tech", label: "Tech & business", emoji: "💻" },
  { slug: "wellness", label: "Wellness", emoji: "🧘" },
  { slug: "social", label: "Community & social", emoji: "👥" },
  { slug: "other", label: "Other", emoji: "✨" },
];

// Metro regions - filtering by one matches all its member cities (the API
// expands them server-side; see apps/api/regions.go - keep the names in sync).
export const REGIONS = [
  "Bay Area, CA", "Orange County, CA", "Greater LA, CA", "Inland Empire, CA",
  "San Diego County, CA", "Sacramento Metro, CA", "NYC Metro", "Greater Boston, MA",
  "Philly Metro, PA", "DC Metro (DMV)", "Chicagoland, IL", "Seattle Area, WA",
  "Portland Metro, OR", "Denver Metro, CO", "Phoenix Valley, AZ", "Salt Lake Valley, UT",
  "Las Vegas Valley, NV", "DFW, TX", "Houston Metro, TX", "Austin Metro, TX",
  "Twin Cities, MN", "Detroit Metro, MI", "Atlanta Metro, GA", "South Florida",
  "Tampa Bay, FL", "Research Triangle, NC",
];

// Curated city list for the <datalist> autocomplete - no external geo API by
// design (privacy, rate limits, deterministic E2E). Extend freely.
export const CITIES = [
  "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia",
  "San Antonio", "San Diego", "Dallas", "Austin", "San Jose", "San Francisco",
  "Seattle", "Denver", "Boston", "Portland", "Miami", "Atlanta", "Washington",
  "Nashville", "Detroit", "Minneapolis", "New Orleans", "Las Vegas", "Salt Lake City",
  "Kansas City", "St. Louis", "Pittsburgh", "Charlotte", "Raleigh", "Columbus",
  "Indianapolis", "Milwaukee", "Sacramento", "Orlando", "Tampa", "San Juan",
  "Anchorage", "Honolulu", "Toronto", "Vancouver", "Montreal", "London", "Paris",
  "Berlin", "Amsterdam", "Madrid", "Barcelona", "Rome", "Dublin", "Lisbon",
  "Stockholm", "Copenhagen", "Oslo", "Helsinki", "Zurich", "Vienna", "Prague",
  "Warsaw", "Athens", "Istanbul", "Dubai", "Mumbai", "Delhi", "Bangalore",
  "Singapore", "Hong Kong", "Tokyo", "Osaka", "Seoul", "Taipei", "Bangkok",
  "Manila", "Jakarta", "Sydney", "Melbourne", "Auckland", "Mexico City",
  "Guadalajara", "Bogotá", "Lima", "Santiago", "Buenos Aires", "São Paulo",
  "Rio de Janeiro", "Cape Town", "Johannesburg", "Nairobi", "Lagos", "Cairo",
];

// What the city datalists offer: regions first, then cities.
export const CITY_OPTIONS = [...REGIONS, ...CITIES];

// Best-effort city prefill from the browser timezone - zero network, zero
// permission prompts (vs. geolocation + a reverse-geocoding API).
const TZ_CITY: Record<string, string> = {
  "America/New_York": "New York", "America/Chicago": "Chicago",
  "America/Denver": "Denver", "America/Phoenix": "Phoenix",
  "America/Los_Angeles": "Los Angeles", "America/Anchorage": "Anchorage",
  "Pacific/Honolulu": "Honolulu", "America/Toronto": "Toronto",
  "America/Vancouver": "Vancouver", "America/Mexico_City": "Mexico City",
  "America/Sao_Paulo": "São Paulo", "America/Argentina/Buenos_Aires": "Buenos Aires",
  "Europe/London": "London", "Europe/Paris": "Paris", "Europe/Berlin": "Berlin",
  "Europe/Amsterdam": "Amsterdam", "Europe/Madrid": "Madrid", "Europe/Rome": "Rome",
  "Europe/Dublin": "Dublin", "Europe/Lisbon": "Lisbon", "Europe/Stockholm": "Stockholm",
  "Europe/Warsaw": "Warsaw", "Europe/Istanbul": "Istanbul", "Asia/Dubai": "Dubai",
  "Asia/Kolkata": "Mumbai", "Asia/Singapore": "Singapore", "Asia/Hong_Kong": "Hong Kong",
  "Asia/Tokyo": "Tokyo", "Asia/Seoul": "Seoul", "Asia/Bangkok": "Bangkok",
  "Australia/Sydney": "Sydney", "Australia/Melbourne": "Melbourne",
  "Pacific/Auckland": "Auckland", "Africa/Johannesburg": "Johannesburg",
  "Africa/Lagos": "Lagos", "Africa/Cairo": "Cairo"
};
// --- add-to-homescreen (PWA install) ---
// Chrome/Android fire beforeinstallprompt once, early - capture it at module
// load so the post-first-event prompt can trigger the NATIVE install dialog.
// iOS has no API (instructions instead); desktop gets nothing (the prompt is
// gated to small screens - a home screen is a phone concept).
type InstallPromptEvent = { preventDefault(): void; prompt: () => Promise<void> };
export let deferredInstall: InstallPromptEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as unknown as InstallPromptEvent;
  });
}
export const isStandalone = () =>
  typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;
export const isIOS = () =>
  /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1);

// --- theme (dark default, light opt-in; persisted) ---
export type Theme = "dark" | "light";
export function getTheme(): Theme {
  try {
    return localStorage.getItem("whensdays.theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
export function applyTheme(t: Theme) {
  try {
    localStorage.setItem("whensdays.theme", t);
  } catch {
    /* ignore */
  }
  const root = document.documentElement;
  if (t === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

// Universal "get directions" URL - opens the native Maps app on iOS/Android and
// Google Maps on desktop. No key, no SDK.
// mapsUrl / appleMapsUrl - there's no single link that opens each person's
// *default* map app across platforms, so the event page offers both. Google's
// is a universal web link that opens the Google Maps app on mobile when
// installed; Apple's opens Maps on iOS/macOS and falls back to a web map elsewhere.
export function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export function appleMapsUrl(address: string): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

// iOS never hands an https://google.com/maps link to the Google Maps app the
// way Android app-links do - it opens the web page. So on iPhone/iPad the
// Google Maps link tries the app's URL scheme first and falls back to the web
// URL only if the app isn't installed (the page never went hidden). Android
// and desktop keep the plain href.
export function openGoogleMaps(ev: { preventDefault(): void }, address: string) {
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  ev.preventDefault();
  const t = setTimeout(() => { window.location.href = mapsUrl(address); }, 1200);
  const cancel = () => clearTimeout(t);
  window.addEventListener("pagehide", cancel, { once: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); }, { once: true });
  window.location.href = `comgooglemaps://?q=${encodeURIComponent(address)}`;
}

// Compact relative timestamp for the comment thread ("now", "5m", "3h", "2d",
// then a short date).
export function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function guessCity(): string {
  try {
    return TZ_CITY[Intl.DateTimeFormat().resolvedOptions().timeZone] ?? "";
  } catch {
    return "";
  }
}

export type SeriesItem = { id: string; starts_at: string; status: string };
export type Group = { id: string; owner_id: string; name: string; description: string; emoji: string; created_at: string; icon_url: string };
export type GroupMember = { role: "member" | "admin"; user_id: string; display_name: string | null; handle: string | null; avatar_url: string | null };
export type GroupDetail = { group: Group; members: GroupMember[]; events: Event[]; is_owner: boolean; is_admin: boolean };

export type Comment = {
  id: string;
  event_id: string;
  user_id: string;
  body: string;
  gif_url: string;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
};
export type Cohost = {
  user_id: string;
  display_name: string | null;
  handle: string | null;
  avatar_url: string | null;
  created_at: string;
};

export type TimeOption = { id: string; event_id: string; starts_at: string };
export type Vote = { id: string; option_id: string; user_id: string; response: "yes" | "no" | "maybe" };
// dimension 'month' -> value "YYYY-MM"; dimension 'slot' -> value "<weekday>:<daypart>".
// dimension: month + slot (general scope), day (month scope), dayslot (week scope),
// timeslot (dates scope) -> value "YYYY-MM-DD:<minutes-from-midnight>".
export type GeneralVote = { user_id: string; dimension: "month" | "slot" | "day" | "dayslot" | "timeslot"; value: string };
export type Attendee = { user_id: string; rsvp: "going" | "maybe" | "declined" | "waitlist"; display_name: string | null; avatar_url: string | null; handle: string | null };
export type PrefAnswer = { user_id: string; question_key: string; answer: string; display_name: string | null };

export type EventDetail = {
  event: Event;
  host_name: string;
  host_avatar: string;
  role: "host" | "cohost" | "guest";
  can_manage: boolean;
  viewer_id: string;
  muted: boolean;
  // Everyone who answered a poll (incl. pure voters with no RSVP/attendee row).
  voters: { user_id: string; display_name: string; avatar_url: string }[];
  // Per-poll-option availability across ALL attendees (from their saved
  // availability days): option_id -> {free, busy} counts.
  option_fit: Record<string, { free: number; busy: number }>;
  time_options: TimeOption[];
  votes: Vote[];
  general_votes: GeneralVote[];
  // 'dates'-scope polls: the host-picked days + the time-grid window (else null).
  poll_days: string[] | null;
  time_grid: { start_min: number; end_min: number; slot_min: number } | null;
  attendees: Attendee[];
  preference_answers: PrefAnswer[];
  comments: Comment[];
  cohosts: Cohost[];
  series: SeriesItem[] | null;
  invites: { user_id: string; inviter_id: string; seen: boolean; display_name: string | null }[];
};

export type Badges = { invites: number; friend_requests: number };

export type Profile = { user_id: string; display_name: string; handle: string; avatar_url: string; created_at: string; email: string };
export type AvailStatus = "free" | "busy";
export type AvailabilitySlot = { user_id: string; weekday: number; part_of_day: string; status?: AvailStatus };
export type Friend = { id: string; friend_id: string; display_name: string; handle: string; avatar_url: string };
export type FriendRequest = { id: string; requester_id?: string; addressee_id?: string; display_name: string; handle: string };
export type Commitment = { id: string; title: string; starts_at: string };

export type CalendarProvider = "google" | "apple_ical" | "apple_caldav";
export type CalendarConnection = { provider: CalendarProvider; account_label: string; created_at: string };
export type ImportedEvent = {
  provider: CalendarProvider;
  title: string;
  starts_at: string;
  ends_at?: string;
  all_day: boolean;
  location: string;
};

// --- API context: a single fetch function that carries auth (Clerk or dev) ---

export type ApiFn = (path: string, init?: RequestInit) => Promise<Response>;

export const ApiContext = createContext<ApiFn>(async () => {
  throw new Error("ApiContext not provided");
});
export const useApi = () => useContext(ApiContext);

// Current user's profile (guaranteed present once past the ProfileGate).
export const ProfileContext = createContext<Profile | null>(null);
export const useProfile = () => useContext(ProfileContext);

// JSON helpers on top of the api fetch.
export async function getJSON<T>(api: ApiFn, path: string): Promise<T> {
  const res = await api(path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function sendJSON(api: ApiFn, method: string, path: string, body: unknown): Promise<Response> {
  return api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- formatting ---

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const PARTS = ["morning", "afternoon", "evening"] as const;

// Columns for the recurring weekly availability grid (coarser than DAYPARTS).
export const WEEK_PARTS: { value: string; short: string }[] = [
  { value: "morning", short: "Morn" },
  { value: "afternoon", short: "Aft" },
  { value: "evening", short: "Eve" },
];

// Coarse time-of-day buckets (value + full label + short label for tight grids).
export const DAYPARTS: { value: string; label: string; short: string }[] = [
  { value: "early_morning", label: "Early morning", short: "Early" },
  { value: "morning", label: "Morning", short: "Morn" },
  { value: "noon", label: "Noon", short: "Noon" },
  { value: "afternoon", label: "Afternoon", short: "Aft" },
  { value: "evening", label: "Evening", short: "Eve" },
  { value: "night", label: "Night", short: "Night" },
];

export type AvailabilityDay = { day: string; daypart: string; status?: AvailStatus };

// n calendar days starting `startOffset` days from today, as
// { value: "YYYY-MM-DD", label: "Fri Jun 27" }. Used for paginating the explicit
// availability calendar further into the future.
export function daysFrom(startOffset: number, n: number): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + startOffset + i);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { value, label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) };
  });
}

// The next n calendar days from today.
export function nextDays(n: number): { value: string; label: string }[] {
  return daysFrom(0, n);
}

// n calendar days starting at an ISO timestamp (e.g. an event's created_at).
// Scoped general polls anchor their answer window here so every attendee sees
// the same dates no matter when they open the invite.
export function daysFromDate(startISO: string, n: number): { value: string; label: string }[] {
  const s = new Date(startISO);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(s.getFullYear(), s.getMonth(), s.getDate() + i);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { value, label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) };
  });
}

// The next n calendar months as { value: "YYYY-MM", label: "Aug 2026" }.
export function nextMonths(n: number): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return { value, label: d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) };
  });
}

// --- time-grid ('dates' scope) helpers ---

// Minutes-from-midnight → "9:00 AM" / "6:30 PM" (12-hour, locale-ish).
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60), min = m % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ap}`;
}

// The slot start-minutes of a grid window [start, end) at `step` granularity.
export function gridSlots(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let m = start; m < end; m += step) out.push(m);
  return out;
}

// "YYYY-MM-DD" → { value, label:"Wed Jul 15" } for a date column/row header.
export function dayLabel(value: string): { value: string; label: string } {
  const [y, mo, d] = value.split("-").map(Number);
  return { value, label: new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) };
}

// --- imported-calendar busy mapping (calendar as moat) ---

// Hour → coarse daypart bucket (mirrors the API's daypart vocabulary).
export function hourToDaypart(h: number): string {
  if (h < 8) return "early_morning";
  if (h < 11) return "morning";
  if (h < 14) return "noon";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

// Map imported events to a busy Set<"YYYY-MM-DD:daypart"> for DayGrid overlays,
// plus raw [start,end) intervals for conflict badges. Untimed/all-day events
// block the whole day; timed events default to 2h when no end is given.
// Anything with a start (and optionally an end / all-day flag) can block cells:
// imported calendar events AND RSVP'd commitments share this shape.
type BusySource = { title: string; starts_at: string; ends_at?: string; all_day?: boolean };

export function importedBusy(events: BusySource[]): { cells: Set<string>; intervals: { start: Date; end: Date; title: string }[] } {
  const cells = new Set<string>();
  const intervals: { start: Date; end: Date; title: string }[] = [];
  for (const e of events) {
    const start = new Date(e.starts_at);
    const end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 2 * 3600_000);
    const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    if (e.all_day) {
      DAYPARTS.forEach((dp) => cells.add(`${day}:${dp.value}`));
    } else {
      for (let t = start.getTime(); t < end.getTime(); t += 3600_000) {
        cells.add(`${day}:${hourToDaypart(new Date(t).getHours())}`);
      }
      intervals.push({ start, end, title: e.title });
    }
  }
  return { cells, intervals };
}

// commitmentBusy maps RSVP'd-going events (2h assumed, like the ICS default)
// onto availability-grid cells - an RSVP automatically shows as booked without
// ever writing to availability_days (derived, so it can't go stale).
export function commitmentBusy(commitments: Commitment[]): Set<string> {
  return importedBusy(commitments.map((c) => ({ title: c.title, starts_at: c.starts_at }))).cells;
}

// The imported event (if any) that overlaps [when, when+2h).
export function busyConflict(intervals: { start: Date; end: Date; title: string }[], whenISO: string): string | null {
  const s = new Date(whenISO).getTime();
  const e = s + 2 * 3600_000;
  const hit = intervals.find((iv) => iv.start.getTime() < e && s < iv.end.getTime());
  return hit ? hit.title : null;
}

// toDatetimeLocal formats an instant as a <input type="datetime-local"> value
// ("YYYY-MM-DDTHH:mm") in the viewer's local zone - for editing a start time.
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// hostTimezone is the browser's IANA timezone (e.g. "America/Los_Angeles"),
// captured at event creation so all times render in the host's zone.
export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

// fmtDateTime/fmtDate render an instant. Pass the event's `tz` to show it in the
// event's (host's) timezone with the zone label; omit it to use the viewer's
// local zone. An unknown tz string falls back to local rather than throwing.
export function fmtDateTime(iso: string | null, tz?: string): string {
  if (!iso) return "TBD";
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  };
  if (tz) { opts.timeZone = tz; opts.timeZoneName = "short"; }
  try {
    return new Date(iso).toLocaleString(undefined, opts);
  } catch {
    delete opts.timeZone; delete opts.timeZoneName;
    return new Date(iso).toLocaleString(undefined, opts);
  }
}

export function fmtDate(iso: string | null, tz?: string): string {
  if (!iso) return "Date TBD";
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  if (tz) opts.timeZone = tz;
  try {
    return new Date(iso).toLocaleDateString(undefined, opts);
  } catch {
    delete opts.timeZone;
    return new Date(iso).toLocaleDateString(undefined, opts);
  }
}
