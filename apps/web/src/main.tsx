import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { App, DEV_AUTH } from "./App";
import { initAnalytics } from "./analytics";

initAnalytics();

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
