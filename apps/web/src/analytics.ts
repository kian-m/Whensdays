import posthog from "posthog-js";

// Frontend analytics wrapper. Safe to call always: when VITE_PUBLIC_POSTHOG_KEY
// is unset (hermetic E2E/docs builds, or any build without analytics) every call
// is a no-op. The distinct id is the app user id (Clerk sub / "demo-user") — the
// SAME id the API uses — so client and server events stitch to one person.
//
// Config (all public, baked into the bundle at build time):
//   VITE_PUBLIC_POSTHOG_KEY     project API key (phc_...)
//   VITE_PUBLIC_POSTHOG_HOST    e.g. https://us.i.posthog.com
//   VITE_PUBLIC_POSTHOG_RECORD  "false" to disable session replay (default on, masked)

const KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";
const RECORD = (import.meta.env.VITE_PUBLIC_POSTHOG_RECORD as string | undefined) !== "false";

let enabled = false;

// Canonical client-side event names. Backend owns the authoritative business
// events (event_created, rsvp_submitted, …); these are UI/intent signals the
// server can't see. Keep names snake_case to match the backend.
export const EVENTS = {
  createEventOpened: "create_event_opened",
  previewToggled: "preview_as_guest_toggled",
  shareLinkCopied: "share_link_copied",
  friendAvailabilityViewed: "friend_availability_viewed",
  addToCalendarClicked: "add_to_calendar_clicked",
  calendarConnectStarted: "calendar_connect_started",
  intentLinkClicked: "intent_link_clicked",
  followed: "followed",
  gifPicked: "gif_picked",
} as const;

export function initAnalytics() {
  if (!KEY) {
    console.info("[analytics] disabled (no VITE_PUBLIC_POSTHOG_KEY)");
    return;
  }
  posthog.init(KEY, {
    api_host: HOST,
    // Only create person profiles for identified (signed-in) users — cheaper,
    // and anonymous landing traffic still shows up in event trends.
    person_profiles: "identified_only",
    // We capture pageviews manually on route change (SPA), so disable auto.
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: true,
    // Frontend error tracking -> feeds anomaly alerts.
    capture_exceptions: true,
    // Session replay with all text + inputs masked (no PII captured).
    disable_session_recording: !RECORD,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
    },
  });
  enabled = true;
}

export const analytics = {
  capture(event: string, props?: Record<string, unknown>) {
    if (enabled) posthog.capture(event, props);
  },
  identify(distinctId: string, props?: Record<string, unknown>) {
    if (enabled) posthog.identify(distinctId, props);
  },
  pageview() {
    if (enabled) posthog.capture("$pageview");
  },
  reset() {
    if (enabled) posthog.reset();
  },
};
