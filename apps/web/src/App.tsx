import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import "./styles.css";
import { ApiContext, ApiFn, Badges, Profile, ProfileContext, useApi, useProfile } from "./lib";
import { Avatar } from "./ui";
import { analytics } from "./analytics";
import { Home } from "./pages/Home";
import { ProfileSetup } from "./pages/ProfileSetup";
import { Loading } from "./ui";
// Route-level code splitting: the landing/dashboard stay in the main bundle;
// everything else loads on demand (cellular-friendly first paint).
const NewEvent = lazy(() => import("./pages/NewEvent").then((m) => ({ default: m.NewEvent })));
const EventPage = lazy(() => import("./pages/EventPage").then((m) => ({ default: m.EventPage })));
const Friends = lazy(() => import("./pages/Friends").then((m) => ({ default: m.Friends })));
const Calendars = lazy(() => import("./pages/Calendars").then((m) => ({ default: m.Calendars })));
const ProfilePage = lazy(() => import("./pages/Profile").then((m) => ({ default: m.ProfilePage })));
const Groups = lazy(() => import("./pages/Groups").then((m) => ({ default: m.Groups })));
const GroupPage = lazy(() => import("./pages/Groups").then((m) => ({ default: m.GroupPage })));
const Discover = lazy(() => import("./pages/Discover").then((m) => ({ default: m.Discover })));
const Quick = lazy(() => import("./pages/Quick").then((m) => ({ default: m.Quick })));

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

// Dev-only guest simulation: open with ?guest=1 to exercise the no-account
// guest flow in hermetic dev/E2E runs (persisted per tab like the dev user).
function resolveDevGuest(): boolean {
  if (!DEV_AUTH) return false;
  if (new URLSearchParams(window.location.search).get("guest") === "1") sessionStorage.setItem("clsandbox.devGuest", "1");
  return sessionStorage.getItem("clsandbox.devGuest") === "1";
}
const DEV_GUEST = resolveDevGuest();

export function App() {
  return (
    <BrowserRouter>
      <AnalyticsPageviews />
      {DEV_AUTH ? (
        DEV_GUEST ? (
          <GuestFlow />
        ) : (
          <ApiContext.Provider value={devApi}>
            <ProfileGate />
          </ApiContext.Provider>
        )
      ) : (
        <>
          <SignedOut>
            <GuestOrLanding />
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

// --- frictionless guests (growth priority #1) ---
// An invite link works without an account: signed-out visitors on /e/{id} can
// join with just a name; the API mints a guest token we keep in localStorage.

type GuestAuth = { token: string; user_id: string; display_name: string };
const GUEST_KEY = "clsandbox.guest";

function storedGuest(): GuestAuth | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    return raw ? (JSON.parse(raw) as GuestAuth) : null;
  } catch {
    return null;
  }
}

// Signed out: guests with a token (or on an invite link) get the guest app;
// everyone else sees the landing page.
function GuestOrLanding() {
  const { pathname } = useLocation();
  if (storedGuest() || pathname.startsWith("/e/") || pathname.startsWith("/ev/") || pathname.startsWith("/start")) return <GuestFlow />;
  // Discover is public: browsable without any account (follow requires one).
  if (pathname.startsWith("/discover")) {
    return (
      <div className="app">
        <nav className="nav">
          <NavLink to="/" className="brand" aria-label="Whensdays"><span className="dot" /></NavLink>
          <SignInButton mode="modal"><button className="btn sm">Sign in</button></SignInButton>
        </nav>
        <Suspense fallback={<Loading />}><Discover /></Suspense>
      </div>
    );
  }
  return <Landing />;
}

function GuestFlow() {
  const [auth, setAuth] = useState<GuestAuth | null>(storedGuest);
  const { pathname } = useLocation();
  const eventId = pathname.startsWith("/e/") ? pathname.slice(3) : pathname.startsWith("/ev/") ? pathname.slice(4) : null;

  const api: ApiFn = useCallback(
    async (p, i) => {
      const res = await fetch(p, {
        ...i,
        headers: { ...(i?.headers as Record<string, string>), Authorization: `Guest ${auth?.token}` },
      });
      if (res.status === 401) {
        // Expired/invalid token: forget it so the join form shows again.
        localStorage.removeItem(GUEST_KEY);
        setAuth(null);
      }
      return res;
    },
    [auth?.token],
  );

  if (!auth) {
    if (!eventId && !pathname.startsWith("/start")) return <Landing />;
    return (
      <GuestJoin
        eventId={eventId}
        onJoined={(a) => {
          localStorage.setItem(GUEST_KEY, JSON.stringify(a));
          setAuth(a);
        }}
      />
    );
  }
  return (
    <ApiContext.Provider value={api}>
      <ProfileGate />
    </ApiContext.Provider>
  );
}

function GuestJoin({ eventId, onJoined }: { eventId: string | null; onJoined: (a: GuestAuth) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (eventId) analytics.capture("invite_opened", { event_id: eventId });
  }, [eventId]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const res = await fetch("/api/guest/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId ?? "", name }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setErr(b.error || "could not join");
    }
    onJoined((await res.json()) as GuestAuth);
  }

  return (
    <div className="app">
      <div className="hero stack" style={{ alignItems: "center" }}>
        <div className="brand" style={{ fontSize: "1.3rem" }}>
          <span className="dot" /> Whensdays
        </div>
        <h1>{eventId ? "You're invited 🎉" : "Let's make a plan ⚡"}</h1>
        <p className="muted" style={{ maxWidth: 420 }}>
          {eventId
            ? "Tell us your name and you can RSVP, vote on times, and chat — no account needed."
            : "Tell us your name and you can set something up and share the link — no account needed."}
        </p>
        <form className="row" style={{ maxWidth: 360, width: "100%" }} onSubmit={join}>
          <input className="input" data-testid="guest-name" value={name} placeholder="Your name"
            onChange={(e) => setName(e.target.value)} />
          <button className="btn" data-testid="guest-join">Join</button>
        </form>
        {err && <p className="err">{err}</p>}
      </div>
    </div>
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
  const showcase = ["🍽️ Dinner", "🎬 Movie night", "⛺ Camping", "🎉 Party", "🏃 Run club", "🎲 Game night"];
  return (
    <div className="app">
      <div className="land">
        <div className="brand" style={{ fontSize: "1.3rem", justifyContent: "center" }}>
          <span className="dot" /> Whensdays
        </div>
        <h1 className="land-title">Make plans that actually happen.</h1>
        <p className="land-sub">
          The group chat says “we should hang out.” Whensdays turns that into a
          real plan — pick a time or let everyone weigh in, drop one link, and
          watch the yeses roll in.
        </p>
        <div className="land-cta">
          <a href="/start" className="btn" data-testid="start-plan">Start a plan — no account needed</a>
          {!DEV_AUTH && (
            <SignInButton mode="modal">
              <button className="btn ghost" data-testid="sign-in">Sign in</button>
            </SignInButton>
          )}
        </div>
        <div className="land-showcase" aria-hidden>
          {showcase.map((s) => <span key={s} className="chip">{s}</span>)}
        </div>
        <div className="land-points">
          <span><b>No app</b> to download</span>
          <span><b>No account</b> to RSVP</span>
          <span><b>One link</b>, everyone's in</span>
        </div>
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
        <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<NewEvent />} />
          <Route path="/start" element={<Quick />} />
          <Route path="/quick" element={<Quick />} />
          <Route path="/e/:id" element={<EventPage />} />
          <Route path="/ev/:id" element={<EventPage />} />
          <Route path="/friends" element={<Friends />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/g/:id" element={<GroupPage />} />
          <Route path="/calendars" element={<Calendars />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/profile" element={<ProfilePage onUpdated={setProfile} />} />
        </Routes>
        </Suspense>
      </Shell>
    </ProfileContext.Provider>
  );
}

function Shell({ children, hideNav }: { children: React.ReactNode; hideNav?: boolean }) {
  const profile = useProfile();
  const api = useApi();
  const { pathname } = useLocation();
  const [badges, setBadges] = useState<Badges>({ invites: 0, friend_requests: 0 });
  // Refresh the red-dot counts on every route change (cheap count query).
  useEffect(() => {
    let gone = false;
    api("/api/badges").then(async (r) => {
      if (r.ok && !gone) setBadges(await r.json());
    }).catch(() => {});
    return () => { gone = true; };
  }, [api, pathname]);
  return (
    <div className="app">
      <nav className="nav">
        <NavLink to="/" className="brand" aria-label="Whensdays">
          <span className="dot" />
        </NavLink>
        {!hideNav && (
          <div className="nav-right">
            <div className="nav-links">
              <NavLink to="/" end>Events{badges.invites > 0 && <span className="dot-badge" data-testid="nav-badge-events">{badges.invites}</span>}</NavLink>
              <NavLink to="/friends">Friends{badges.friend_requests > 0 && <span className="dot-badge" data-testid="nav-badge-friends">{badges.friend_requests}</span>}</NavLink>
              <NavLink to="/groups">Groups</NavLink>
              <NavLink to="/discover">Discover</NavLink>
              <NavLink to="/calendars">Calendars</NavLink>
              <NavLink to="/profile">Profile</NavLink>
            </div>
            {DEV_AUTH && DEV_USER !== "demo-user" && <span className="pill polling" title="dev user (?as=…)">dev: {DEV_USER}</span>}
            {DEV_AUTH && profile && (
              <NavLink to="/profile" title={profile.display_name}>
                <Avatar url={profile.avatar_url} name={profile.display_name} size={30} />
              </NavLink>
            )}
            {!DEV_AUTH && <UserButton />}
          </div>
        )}
      </nav>
      {/* Guest→account conversion nudge (K-factor): guests keep full access,
          but signing up preserves their plans across devices. */}
      {profile?.user_id.startsWith("guest_") && (
        <div className="card row between" data-testid="guest-banner" style={{ marginBottom: "0.9rem" }}>
          <span className="small">You're in as a guest — sign up to keep your plans on any device.</span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn ghost sm" data-testid="guest-reset"
              onClick={() => { localStorage.removeItem(GUEST_KEY); location.href = "/"; }}>Start over</button>
            {DEV_AUTH ? (
              /* Dev has no Clerk modal — simulate the conversion (guest → signed-in dev user). */
              <button className="btn sm" data-testid="guest-signup"
                onClick={() => { localStorage.removeItem(GUEST_KEY); location.href = "/"; }}>Sign up</button>
            ) : (
              <SignInButton mode="modal">
                <button className="btn sm" data-testid="guest-signup">Sign up</button>
              </SignInButton>
            )}
          </span>
        </div>
      )}
      {children}
      {!hideNav && <TabBar badges={badges} />}
    </div>
  );
}

// Bottom tab bar for mobile (CSS hides it on wider screens). Same destinations
// as the top nav, as icon + label — inspired by app-style bottom navigation.
const TABS = [
  { to: "/", id: "events", label: "Events", end: true, icon: IconHome },
  { to: "/friends", id: "friends", label: "Friends", icon: IconFriends },
  { to: "/groups", id: "groups", label: "Groups", icon: IconGroups },
  { to: "/discover", id: "discover", label: "Discover", icon: IconCompass },
  { to: "/calendars", id: "calendars", label: "Calendars", icon: IconCalendar },
  { to: "/profile", id: "profile", label: "Profile", icon: IconUser },
];

function TabBar({ badges }: { badges: Badges }) {
  const countFor = (id: string) =>
    id === "events" ? badges.invites : id === "friends" ? badges.friend_requests : 0;
  return (
    <nav className="tabbar" data-testid="tabbar">
      {TABS.map((t) => {
        const n = countFor(t.id);
        return (
          <NavLink key={t.to} to={t.to} end={t.end} className="tab" data-testid={`tab-${t.id}`} aria-label={t.label}>
            <span className="icon-wrap">
              <t.icon />
              {n > 0 && <span className="dot-badge" data-testid={`badge-${t.id}`}>{n}</span>}
            </span>
            <span>{t.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

// --- inline line icons (stroke = currentColor so they take the active color) ---
type IconProps = { };
const svgProps = {
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};
function IconHome(_: IconProps) {
  return (
    <svg {...svgProps}><path d="M3 10.8 12 3l9 7.8" /><path d="M5 9.6V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.6" /><path d="M9.5 21v-6h5v6" /></svg>
  );
}
function IconFriends(_: IconProps) {
  return (
    <svg {...svgProps}><circle cx="9.5" cy="8" r="3.2" /><path d="M3.8 19v-1a4 4 0 0 1 4-4h3.4a4 4 0 0 1 4 4v1" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" /><path d="M17.5 14.2A4 4 0 0 1 20.2 18v1" /></svg>
  );
}
function IconCompass(_: IconProps) {
  return (
    <svg {...svgProps}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>
  );
}
function IconGroups(_: IconProps) {
  return (
    <svg {...svgProps}><circle cx="12" cy="7" r="3" /><circle cx="5" cy="10" r="2.4" /><circle cx="19" cy="10" r="2.4" /><path d="M12 13a6 6 0 0 0-6 6h12a6 6 0 0 0-6-6Z" /><path d="M5 15a4 4 0 0 0-3.5 4h3.5" /><path d="M19 15a4 4 0 0 1 3.5 4h-3.5" /></svg>
  );
}
function IconCalendar(_: IconProps) {
  return (
    <svg {...svgProps}><rect x="3.5" y="5" width="17" height="15.5" rx="2.2" /><path d="M3.5 9.5h17" /><path d="M8 3.2v3.4" /><path d="M16 3.2v3.4" /></svg>
  );
}
function IconUser(_: IconProps) {
  return (
    <svg {...svgProps}><circle cx="12" cy="8.2" r="3.6" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
  );
}
