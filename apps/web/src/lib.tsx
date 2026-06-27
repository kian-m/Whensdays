import { createContext, useContext } from "react";

// --- shared domain types (mirror the Go API JSON) ---

export type EventType = "dinner" | "drinks" | "movie" | "camping" | "party" | "trip" | "other";

export type Event = {
  id: string;
  host_id: string;
  title: string;
  event_type: EventType;
  description: string;
  location_mode: "host_place" | "find_venue";
  location_address: string;
  scheduling_mode: "fixed" | "poll" | "general";
  starts_at: string | null;
  status: "polling" | "scheduled" | "cancelled";
  created_at: string;
};

export type TimeOption = { id: string; event_id: string; starts_at: string };
export type Vote = { id: string; option_id: string; user_id: string; response: "yes" | "no" | "maybe" };
// dimension 'month' -> value "YYYY-MM"; dimension 'slot' -> value "<weekday>:<daypart>".
export type GeneralVote = { user_id: string; dimension: "month" | "slot"; value: string };
export type Attendee = { user_id: string; rsvp: "going" | "maybe" | "declined"; display_name: string | null; avatar_url: string | null };
export type PrefAnswer = { user_id: string; question_key: string; answer: string; display_name: string | null };

export type EventDetail = {
  event: Event;
  role: "host" | "guest";
  viewer_id: string;
  time_options: TimeOption[];
  votes: Vote[];
  general_votes: GeneralVote[];
  attendees: Attendee[];
  preference_answers: PrefAnswer[];
};

export type Profile = { user_id: string; display_name: string; handle: string; avatar_url: string; created_at: string };
export type AvailabilitySlot = { user_id: string; weekday: number; part_of_day: string };
export type Friend = { friend_id: string; display_name: string; handle: string; avatar_url: string };
export type FriendRequest = { id: string; requester_id?: string; addressee_id?: string; display_name: string; handle: string };
export type Commitment = { id: string; title: string; starts_at: string };

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
export const PARTS = ["morning", "afternoon", "evening"] as const;

// Coarse time-of-day buckets (value + full label + short label for tight grids).
export const DAYPARTS: { value: string; label: string; short: string }[] = [
  { value: "early_morning", label: "Early morning", short: "Early" },
  { value: "morning", label: "Morning", short: "Morn" },
  { value: "noon", label: "Noon", short: "Noon" },
  { value: "afternoon", label: "Afternoon", short: "Aft" },
  { value: "evening", label: "Evening", short: "Eve" },
  { value: "night", label: "Night", short: "Night" },
];

export type AvailabilityDay = { day: string; daypart: string };

// The next n calendar days as { value: "YYYY-MM-DD", label: "Fri Jun 27" }.
export function nextDays(n: number): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
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

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "Date TBD";
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
