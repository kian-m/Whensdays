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
  trivia: [
    { key: "team", prompt: "Team name ideas?", placeholder: "Quiz Khalifa, Les Quizerables…" },
    { key: "category", prompt: "Your strongest category?", placeholder: "History, pop culture, science…" },
  ],
  party: [
    { key: "bringing", prompt: "Bringing anything?", placeholder: "Snacks, a +1, a playlist…" },
    { key: "song", prompt: "A song you need to hear?", placeholder: "Request away" },
  ],
  other: [
    { key: "notes", prompt: "Anything the host should know?", placeholder: "Optional" },
  ],
};

export const EVENT_TYPES: { value: EventType; label: string; emoji: string }[] = [
  { value: "dinner", label: "Dinner", emoji: "🍝" },
  { value: "drinks", label: "Drinks", emoji: "🍸" },
  { value: "movie", label: "Movie", emoji: "🎬" },
  { value: "trivia", label: "Trivia", emoji: "🧠" },
  { value: "party", label: "Party", emoji: "🎉" },
  { value: "other", label: "Other", emoji: "✨" },
];

export const emojiFor = (t: EventType) => EVENT_TYPES.find((e) => e.value === t)?.emoji ?? "✨";
export const labelFor = (t: EventType) => EVENT_TYPES.find((e) => e.value === t)?.label ?? "Event";
export const questionLabel = (t: EventType, key: string) =>
  QUESTIONS[t]?.find((q) => q.key === key)?.prompt ?? key;
