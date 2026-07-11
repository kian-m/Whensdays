// Frontend analytics wrapper. Safe to call always: when VITE_PUBLIC_POSTHOG_KEY
// is unset (hermetic E2E/docs builds, or any build without analytics) every call
// is a no-op. The distinct id is the app user id (Clerk sub / "demo-user") - the
// SAME id the API uses - so client and server events stitch to one person.
//
// Config (all public, baked into the bundle at build time):
//   VITE_PUBLIC_POSTHOG_KEY     project API key (phc_...)
//   VITE_PUBLIC_POSTHOG_HOST    e.g. https://us.i.posthog.com
//   VITE_PUBLIC_POSTHOG_RECORD  "false" to disable session replay (default on, masked)

const KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";
const RECORD = (import.meta.env.VITE_PUBLIC_POSTHOG_RECORD as string | undefined) !== "false";

// Canonical client-side event names. Backend owns the authoritative business
// events (event_created, rsvp_submitted, …); these are UI/intent signals the
// server can't see. Keep names snake_case to match the backend.
export const EVENTS = {
  createEventOpened: "create_event_opened",
  previewToggled: "preview_as_guest_toggled",
  notificationsMuted: "event_notifications_muted",
  shareLinkCopied: "share_link_copied",
  friendAvailabilityViewed: "friend_availability_viewed",
  addToCalendarClicked: "add_to_calendar_clicked",
  calendarConnectStarted: "calendar_connect_started",
  intentLinkClicked: "intent_link_clicked",
  followed: "followed",
  gifPicked: "gif_picked",
  guestSignupClicked: "guest_signup_clicked",
  qrOpened: "qr_code_opened",
} as const;

// posthog-js is ~fifty KB gzipped - keep it OUT of the critical bundle. The
// library loads on idle after first paint; calls made before then queue and
// flush in order once it's ready, so no event is lost.
type PostHog = typeof import("posthog-js").default;
let ph: PostHog | null = null;
let pending: Array<(p: PostHog) => void> = [];
const run = (fn: (p: PostHog) => void) => {
  if (ph) fn(ph);
  // Nothing queues while consent is pending/denied - pre-consent activity is
  // never collected, not just never sent.
  else if (KEY && !consentBlocked()) pending.push(fn);
};

// --- region-based consent (GDPR/ePrivacy) ---------------------------------
// PostHog sets cookies + a persistent id (+ masked replay), which needs PRIOR
// consent in the EU/UK. The US doesn't require a banner for analytics, so:
// EU-ish visitors (timezone heuristic - zero network, slightly over-inclusive
// which is the safe direction) get an Accept/Decline bar and PostHog stays
// unloaded until they accept; everyone else loads as before. The choice
// persists in localStorage; declined = analytics never load on this device.
const CONSENT_KEY = "whensdays.consent";

function inConsentRegion(): boolean {
  try {
    if (new URLSearchParams(location.search).get("consent") === "force") return true; // E2E/dev hook
    return Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith("Europe/");
  } catch {
    return false;
  }
}

function storedConsent(): string {
  try {
    return localStorage.getItem(CONSENT_KEY) ?? "";
  } catch {
    return "";
  }
}

// needsConsent: the banner renders while this is true.
export function needsConsent(): boolean {
  return !!KEY && inConsentRegion() && storedConsent() === "";
}

export function grantConsent() {
  try { localStorage.setItem(CONSENT_KEY, "granted"); } catch { /* private mode */ }
  loadPosthog(); // start now; anything queued flushes in order
}

export function denyConsent() {
  try { localStorage.setItem(CONSENT_KEY, "denied"); } catch { /* private mode */ }
  pending = []; // drop anything queued - it will never be sent
}

function consentBlocked(): boolean { return inConsentRegion() && storedConsent() !== "granted"; }

const loadPosthog = async () => {
  if (ph || !KEY || consentBlocked()) return;
  const { default: posthog } = await import("posthog-js");
  init(posthog);
  ph = posthog;
  pending.forEach((fn) => fn(posthog));
  pending = [];
};

export function initAnalytics() {
  if (!KEY) {
    console.info("[analytics] disabled (no VITE_PUBLIC_POSTHOG_KEY)");
    return;
  }
  if (consentBlocked()) return; // the banner's Accept triggers loading instead
  if ("requestIdleCallback" in window) requestIdleCallback(() => void loadPosthog(), { timeout: 3000 });
  else setTimeout(() => void loadPosthog(), 1500);
}

function init(posthog: PostHog) {
  posthog.init(KEY!, {
    api_host: HOST,
    // Dated defaults preset - opts into PostHog's current recommended behaviors.
    defaults: "2026-05-30",
    // When HOST is a reverse proxy (prod: PostHog managed proxy on our domain,
    // so adblockers don't eat events), links/toolbar still need the real UI.
    ui_host: "https://us.posthog.com",
    // Only create person profiles for identified (signed-in) users - cheaper,
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
}

export const analytics = {
  capture(event: string, props?: Record<string, unknown>) {
    run((p) => p.capture(event, props));
  },
  identify(distinctId: string, props?: Record<string, unknown>) {
    run((p) => p.identify(distinctId, props));
  },
  pageview() {
    run((p) => p.capture("$pageview"));
  },
  reset() {
    run((p) => p.reset());
  },
};
