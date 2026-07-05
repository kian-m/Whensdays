import type { EventType } from "../lib";

// Airtable-style preference questions, asked one at a time, keyed by event type.
// The API stores answers as opaque key/value pairs; these definitions drive both
// the guest's one-question-at-a-time flow and the host's answer summary.

export type Question = { key: string; prompt: string; placeholder?: string };

export const QUESTIONS: Record<EventType, Question[]> = {
  dinner: [
    { key: "dietary", prompt: "Any dietary needs we should plan around?", placeholder: "Vegetarian, allergies, none…" },
    { key: "cuisine", prompt: "What are you craving?", placeholder: "Italian, sushi, tacos…" },
  ],
  drinks: [
    { key: "drink", prompt: "What's your go-to order?", placeholder: "Negroni, IPA, mocktail…" },
    { key: "vibe", prompt: "Cozy spot or somewhere lively?", placeholder: "Cozy / lively / either" },
  ],
  movie: [
    { key: "genre", prompt: "What genre are you in the mood for?", placeholder: "Horror, comedy, A24…" },
    { key: "seen", prompt: "Anything you've already seen?", placeholder: "So we don't pick it" },
  ],
  camping: [
    { key: "sleep", prompt: "Tent, cabin, or RV?", placeholder: "Tent / cabin / RV" },
    { key: "gear", prompt: "Bringing any gear?", placeholder: "Tent, cooler, chairs, marshmallows…" },
  ],
  party: [
    { key: "bringing", prompt: "Bringing anything?", placeholder: "Snacks, a +1, a playlist…" },
    { key: "song", prompt: "A song you need to hear?", placeholder: "Request away" },
  ],
  trip: [
    { key: "destination", prompt: "Where are we headed?", placeholder: "Lake, city, mountains…" },
    { key: "nights", prompt: "How many nights?", placeholder: "1, 2, a long weekend…" },
  ],
  other: [
    { key: "notes", prompt: "Anything the host should know?", placeholder: "Optional" },
  ],
};

export const EVENT_TYPES: { value: EventType; label: string; emoji: string }[] = [
  { value: "dinner", label: "Meal", emoji: "🍽️" },
  { value: "drinks", label: "Drinks", emoji: "🍸" },
  { value: "movie", label: "Movie", emoji: "🎬" },
  { value: "camping", label: "Camping", emoji: "⛺" },
  { value: "party", label: "Party", emoji: "🎉" },
  { value: "trip", label: "Trip", emoji: "✈️" },
  { value: "other", label: "Other", emoji: "✨" },
];

export const emojiFor = (t: EventType) => EVENT_TYPES.find((e) => e.value === t)?.emoji ?? "✨";
export const labelFor = (t: EventType) => EVENT_TYPES.find((e) => e.value === t)?.label ?? "Event";

// Custom-type aware variants: user-defined emoji/name win when present.
type Typed = { event_type: EventType; custom_emoji?: string; custom_label?: string };
export const eventEmoji = (e: Typed) => e.custom_emoji || emojiFor(e.event_type);
export const eventLabel = (e: Typed) => e.custom_label || labelFor(e.event_type);
export const questionLabel = (t: EventType, key: string) =>
  QUESTIONS[t]?.find((q) => q.key === key)?.prompt ?? key;
