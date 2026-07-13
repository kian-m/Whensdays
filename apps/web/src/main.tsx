import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { App, DEV_AUTH } from "./App";
import { initAnalytics } from "./analytics";

// "ResizeObserver loop completed with undelivered notifications" is a benign
// browser notice (an observer callback that itself resized), NOT a bug. Swallow
// it so it stops spamming error tracking. Registered before analytics so this
// runs first and stops the event before PostHog's capture handler sees it.
window.addEventListener("error", (e) => {
  if (typeof e.message === "string" && e.message.startsWith("ResizeObserver loop")) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
});

// One reload per 10s window, shared with App's importChunk() so the two chunk-
// recovery paths coordinate instead of double-reloading. See importChunk.
function reloadForStaleChunk() {
  try {
    const last = Number(sessionStorage.getItem("whensdays.chunkReloadAt") || 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem("whensdays.chunkReloadAt", String(Date.now()));
  } catch { /* private mode - reload anyway, the loop risk is theoretical */ }
  window.location.reload();
}

initAnalytics();

// A failed lazy-chunk load (network blip, or a tab whose cached HTML points at
// pre-deploy chunk hashes) would otherwise wedge the SPA on the old page
// forever - React Router keeps the previous UI rendered while a lazy route
// suspends, so a failed import means the nav silently never completes. One
// reload fetches the fresh manifest (cooldown-gated so a genuinely broken asset
// can't reload-loop).
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadForStaleChunk();
});

const root = createRoot(document.getElementById("root")!);

if (DEV_AUTH) {
  // Hermetic dev/test mode: no auth provider, app renders directly.
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key) throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={key} afterSignOutUrl="/">
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
}
