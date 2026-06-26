import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import "./styles.css";
import { ApiContext, ApiFn, Profile, ProfileContext, useApi } from "./lib";
import { analytics } from "./analytics";
import { Home } from "./pages/Home";
import { NewEvent } from "./pages/NewEvent";
import { EventPage } from "./pages/EventPage";
import { Friends } from "./pages/Friends";
import { ProfilePage } from "./pages/Profile";
import { ProfileSetup } from "./pages/ProfileSetup";

// Build-time constant. When "dev", the app runs without Clerk (hermetic
// local/CI runs). Default (prod) uses Clerk. See main.tsx.
export const DEV_AUTH = import.meta.env.VITE_AUTH_MODE === "dev";

// Dev-only multi-user switch: open the app with ?as=<name> to act as that user
// (the API trusts the X-Dev-User header in dev). Stored per-TAB in sessionStorage
// so two tabs/windows can be two different people at once — handy for testing
// friends, invites, and RSVPs. Defaults to "demo-user". No effect with Clerk.
function resolveDevUser(): string {
  if (!DEV_AUTH) return "";
  const q = new URLSearchParams(window.location.search).get("as");
  if (q) sessionStorage.setItem("clsandbox.devUser", q.trim());
  return sessionStorage.getItem("clsandbox.devUser") || "demo-user";
}
export const DEV_USER = resolveDevUser();

const devApi: ApiFn = (p, i) =>
  fetch(p, { ...i, headers: { ...(i?.headers as Record<string, string>), "X-Dev-User": DEV_USER } });

export function App() {
  return (
    <BrowserRouter>
      <AnalyticsPageviews />
      {DEV_AUTH ? (
        <ApiContext.Provider value={devApi}>
          <ProfileGate />
        </ApiContext.Provider>
      ) : (
        <>
          <SignedOut>
            <Landing />
          </SignedOut>
          <SignedIn>
            <ClerkApiProvider>
              <ProfileGate />
            </ClerkApiProvider>
          </SignedIn>
        </>
      )}
    </BrowserRouter>
  );
}

// Fires a PostHog $pageview on every client-side route change (SPA).
function AnalyticsPageviews() {
  const { pathname } = useLocation();
  useEffect(() => {
    analytics.pageview();
  }, [pathname]);
  return null;
}

function ClerkApiProvider({ children }: { children?: React.ReactNode }) {
  const { getToken } = useAuth();
  // Every request carries the Clerk session token; the API verifies it.
  const api: ApiFn = useCallback(
    async (path, init) => {
      const token = await getToken();
      return fetch(path, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${token}` },
      });
    },
    [getToken],
  );
  return <ApiContext.Provider value={api}>{children ?? <ProfileGate />}</ApiContext.Provider>;
}

function Landing() {
  // Signed out: clear any prior identity from this browser.
  useEffect(() => {
    analytics.reset();
  }, []);
  return (
    <div className="app">
      <div className="hero stack" style={{ alignItems: "center" }}>
        <div className="brand" style={{ fontSize: "1.3rem" }}>
          <span className="dot" /> get-togethers
        </div>
        <h1>Plans, minus the group chat chaos.</h1>
        <p className="muted" style={{ maxWidth: 440 }}>
          Spin up dinner, drinks, movie night or trivia in seconds. Pick a time —
          or let everyone vote — and we'll sort out who's in.
        </p>
        <SignInButton mode="modal">
          <button className="btn" data-testid="sign-in">Get started</button>
        </SignInButton>
      </div>
    </div>
  );
}

// Ensures the signed-in user has a minimal profile (name + handle) before using
// the app. A 404 from /api/profile means "not set up yet".
function ProfileGate() {
  const api = useApi();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<"loading" | "needs-setup" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api("/api/profile");
      if (cancelled) return;
      if (res.status === 404) return setState("needs-setup");
      if (!res.ok) return setState("needs-setup");
      setProfile(await res.json());
      setState("ready");
    })().catch(() => !cancelled && setState("needs-setup"));
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Tie analytics to the app user id (same id the API uses) once known.
  useEffect(() => {
    if (profile) analytics.identify(profile.user_id, { handle: profile.handle });
  }, [profile]);

  if (state === "loading") return <div className="app"><p className="muted" style={{ marginTop: "3rem" }}>Loading…</p></div>;
  if (state === "needs-setup")
    return (
      <Shell hideNav>
        <ProfileSetup
          onDone={(p) => {
            setProfile(p);
            setState("ready");
          }}
        />
      </Shell>
    );

  return (
    <ProfileContext.Provider value={profile}>
      <Shell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<NewEvent />} />
          <Route path="/e/:id" element={<EventPage />} />
          <Route path="/friends" element={<Friends />} />
          <Route path="/profile" element={<ProfilePage onUpdated={setProfile} />} />
        </Routes>
      </Shell>
    </ProfileContext.Provider>
  );
}

function Shell({ children, hideNav }: { children: React.ReactNode; hideNav?: boolean }) {
  return (
    <div className="app">
      <nav className="nav">
        <NavLink to="/" className="brand">
          <span className="dot" /> get-togethers
        </NavLink>
        {!hideNav && (
          <div className="nav-links">
            <NavLink to="/" end>Events</NavLink>
            <NavLink to="/friends">Friends</NavLink>
            <NavLink to="/profile">Profile</NavLink>
            {DEV_AUTH && <span className="pill polling" title="dev user (?as=…)">dev: {DEV_USER}</span>}
            {!DEV_AUTH && <UserButton />}
          </div>
        )}
      </nav>
      {children}
    </div>
  );
}
