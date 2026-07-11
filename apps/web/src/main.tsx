import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { App, DEV_AUTH } from "./App";
import { initAnalytics } from "./analytics";

initAnalytics();

// A failed lazy-chunk load (network blip, or a tab whose cached HTML points at
// pre-deploy chunk hashes) would otherwise wedge the SPA on the old page
// forever - React Router keeps the previous UI rendered while a lazy route
// suspends, so a failed import means the nav silently never completes. One
// reload fetches the fresh manifest. Sessionstorage-gated so a genuinely
// broken asset can't reload-loop.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  try {
    if (sessionStorage.getItem("whensdays.reloaded") === location.href) return;
    sessionStorage.setItem("whensdays.reloaded", location.href);
  } catch { /* private mode - reload anyway, the loop risk is theoretical */ }
  window.location.reload();
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
