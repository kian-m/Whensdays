import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  ClerkLoading,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  useAuth,
} from "@clerk/clerk-react";
import "./styles.css";
import { ApiContext, ApiFn, Badges, Profile, ProfileContext, fetchDashboard, useApi, useProfile } from "./lib";
import { Avatar } from "./ui";
import { analytics, EVENTS, denyConsent, grantConsent, needsConsent } from "./analytics";
import { Home } from "./pages/Home";
import { ProfileSetup } from "./pages/ProfileSetup";
import { ListSkeleton, warmAsync } from "./ui";
// A dynamic import that survives a deploy. After we ship a new build the hashed
// chunk filenames change, so a tab still running the OLD index.html asks for a
// chunk hash that no longer exists; Cloudflare serves the SPA index.html
// fallback (text/html) and the module loader throws "'text/html' is not a valid
// JavaScript MIME type" / "Failed to fetch dynamically imported module". Reload
// ONCE to pick up the fresh index.html + new hashes; a 10s cooldown prevents a
// reload loop if the asset is genuinely broken (then the error surfaces).
function importChunk<T>(factory: () => Promise<T>): Promise<T> {
  return factory().catch((err: unknown) => {
    const KEY = "whensdays.chunkReloadAt";
    let last = 0;
    try { last = Number(sessionStorage.getItem(KEY) || 0); } catch { /* private mode */ }
    if (Date.now() - last > 10_000) {
      try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ }
      window.location.reload();
      return new Promise<T>(() => {}); // never resolves; the reload takes over
    }
    throw err;
  });
}

// Route-level code splitting: the landing/dashboard stay in the main bundle;
// everything else loads on demand (cellular-friendly first paint).
const NewEvent = lazy(() => importChunk(() => import("./pages/NewEvent").then((m) => ({ default: m.NewEvent }))));
const EventPage = lazy(() => importChunk(() => import("./pages/EventPage").then((m) => ({ default: m.EventPage }))));
const Friends = lazy(() => importChunk(() => import("./pages/Friends").then((m) => ({ default: m.Friends }))));
const Calendars = lazy(() => importChunk(() => import("./pages/Calendars").then((m) => ({ default: m.Calendars }))));
const ProfilePage = lazy(() => importChunk(() => import("./pages/Profile").then((m) => ({ default: m.ProfilePage }))));
const Groups = lazy(() => importChunk(() => import("./pages/Groups").then((m) => ({ default: m.Groups }))));
const GroupPage = lazy(() => importChunk(() => import("./pages/Groups").then((m) => ({ default: m.GroupPage }))));
const Discover = lazy(() => importChunk(() => import("./pages/Discover").then((m) => ({ default: m.Discover }))));
const Quick = lazy(() => importChunk(() => import("./pages/Quick").then((m) => ({ default: m.Quick }))));

// Warm the lazy chunks once the first paint has settled: navigation then swaps
// routes instantly instead of flashing "Loading…". Chunks are tiny and cached,
// so this trades a few idle-time requests for zero perceived nav latency.
function warmRouteChunks() {
  // Prefetch only - swallow failures silently (a stale-tab chunk 404 here must
  // not become an unhandled rejection in error tracking, and must NOT reload
  // the page from the background; the corrective reload only happens when the
  // user actually navigates into a route, via importChunk above).
  const swallow = () => {};
  const warm = () => {
    import("./pages/EventPage").catch(swallow);
    import("./pages/NewEvent").catch(swallow);
    import("./pages/Quick").catch(swallow);
    import("./pages/Friends").catch(swallow);
    import("./pages/Groups").catch(swallow);
    import("./pages/Profile").catch(swallow);
    import("./pages/Calendars").catch(swallow);
  };
  if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2000);
}

// Build-time constant. When "dev", the app runs without Clerk (hermetic
// local/CI runs). Default (prod) uses Clerk. See main.tsx.
export const DEV_AUTH = import.meta.env.VITE_AUTH_MODE === "dev";

// Dev-only multi-user switch: open the app with ?as=<name> to act as that user
// (the API trusts the X-Dev-User header in dev). Stored per-TAB in sessionStorage
// so two tabs/windows can be two different people at once - handy for testing
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

// One signup affordance for guests, reused by the shell banner and in-flow
// nudges: dev mode simulates conversion (drop the guest flag, reload as the
// dev user); Clerk mode opens the real modal.
export function GuestSignupButton({ testid, label = "Sign up", source }: { testid: string; label?: string; source: string }) {
  if (DEV_AUTH) {
    return (
      <button className="btn sm" data-testid={testid}
        onClick={() => { analytics.capture(EVENTS.guestSignupClicked, { mode: "dev", source }); sessionStorage.removeItem("clsandbox.devGuest"); location.href = "/"; }}>
        {label}
      </button>
    );
  }
  return (
    <a href="/sign-in" className="btn sm" data-testid={testid}
      onClick={() => analytics.capture(EVENTS.guestSignupClicked, { mode: "clerk", source })}>{label}</a>
  );
}

// GDPR/ePrivacy banner - only renders for EU-timezone visitors with no stored
// choice (see analytics.ts). Accept starts PostHog; Decline keeps this device
// analytics-free for good. US visitors never see it.
function ConsentBanner() {
  const [open, setOpen] = useState(needsConsent);
  if (!open) return null;
  return (
    <div className="consent-bar" data-testid="consent-banner" role="dialog" aria-label="Cookie consent">
      <span className="small" style={{ minWidth: 0 }}>
        🍪 We use analytics cookies (PostHog) to understand what to improve - no ads, nothing sold.{" "}
        <a href="/cookies/" style={{ textDecoration: "underline" }}>Cookie policy</a>
      </span>
      <span className="row" style={{ gap: 6, flex: "none" }}>
        <button className="btn ghost sm" data-testid="consent-decline" onClick={() => { denyConsent(); setOpen(false); }}>Decline</button>
        <button className="btn sm" data-testid="consent-accept" onClick={() => { grantConsent(); setOpen(false); }}>Accept</button>
      </span>
    </div>
  );
}

export function App() {
  useEffect(() => warmRouteChunks(), []);
  return (
    <BrowserRouter>
      <ConsentBanner />
      <AnalyticsPageviews />
      {DEV_AUTH ? (
        window.location.pathname === "/landing" ? (
          // Dev-only alias: the landing never renders in dev auth mode (no
          // signed-out state exists), so E2E reaches it here.
          <Landing />
        ) : DEV_GUEST ? (
          <GuestFlow />
        ) : (
          <ApiContext.Provider value={devApi}>
            <ProfileGate canMerge />
          </ApiContext.Provider>
        )
      ) : (
        <>
          {/* Until clerk-js (~300KB, external) loads and resolves the session,
              SignedIn/SignedOut render NOTHING - that blank was the slowest
              part of first load. Show the shell + skeleton immediately. */}
          <ClerkLoading>
            <Shell hideNav><ListSkeleton rows={4} header /></Shell>
          </ClerkLoading>
          <SignedOut>
            <GuestOrLanding />
          </SignedOut>
          <SignedIn>
            <ClerkApiProvider>
              <ProfileGate canMerge />
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
// Sign-in / sign-up live on their OWN pages (not a modal): the email-code flow
// means the user tabs away to fetch the code, and a modal would vanish on
// return, forcing a restart. A page stays mounted, so the flow survives the
// round-trip. `routing="virtual"` keeps every step inside this one component
// (no URL sub-paths / catch-all route needed).
function AuthPage({ kind }: { kind: "in" | "up" }) {
  // An invite link's "Log in" passes where to land after auth. Same-origin
  // paths only - anything else falls back to "/" (open-redirect guard).
  const raw = new URLSearchParams(window.location.search).get("redirect_url") || "/";
  const dest = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  return (
    <div className="app">
      <nav className="nav">
        <a href="/" className="brand" aria-label="Whensdays"><span className="dot" /><span className="word" /></a>
      </nav>
      <div style={{ display: "grid", placeItems: "center", padding: "1.5rem 0" }}>
        {kind === "in"
          ? <SignIn routing="virtual" signUpUrl="/sign-up" fallbackRedirectUrl={dest} />
          : <SignUp routing="virtual" signInUrl="/sign-in" fallbackRedirectUrl={dest} />}
      </div>
    </div>
  );
}

function GuestOrLanding() {
  const { pathname } = useLocation();
  // Auth pages first - reachable even for stored guests (converting to an account).
  if (pathname.startsWith("/sign-in")) return <AuthPage kind="in" />;
  if (pathname.startsWith("/sign-up")) return <AuthPage kind="up" />;
  if (storedGuest() || pathname.startsWith("/e/") || pathname.startsWith("/ev/") || pathname.startsWith("/g/") || pathname.startsWith("/gv/") || pathname.startsWith("/start")) return <GuestFlow />;
  // Discover is public: browsable without any account (follow requires one).
  if (pathname.startsWith("/discover")) {
    return (
      <div className="app">
        <nav className="nav">
          <NavLink to="/" className="brand" aria-label="Whensdays"><span className="dot" /><span className="word" /></NavLink>
          <a href="/sign-in" className="btn sm" data-testid="sign-in">Sign in</a>
        </nav>
        <Suspense fallback={<ListSkeleton rows={3} header />}><Discover /></Suspense>
      </div>
    );
  }
  return <Landing />;
}

function GuestFlow() {
  const [auth, setAuth] = useState<GuestAuth | null>(storedGuest);
  const { pathname } = useLocation();
  const eventId = pathname.startsWith("/e/") ? pathname.slice(3) : pathname.startsWith("/ev/") ? pathname.slice(4) : null;
  const groupInvite = pathname.startsWith("/g/") || pathname.startsWith("/gv/"); // group links invite guests too (/g/ = unfurl path, /gv/ = SPA alias)

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
    if (!eventId && !groupInvite && !pathname.startsWith("/start")) return <Landing />;
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
        <div className="brand" aria-label="Whensdays">
          <span className="dot" /><span className="word" />
        </div>
        <h1>{eventId ? "You're invited 🎉" : "Let's make a plan ⚡"}</h1>
        <p className="muted" style={{ maxWidth: 420 }}>
          {eventId
            ? "Tell us your name and you can RSVP, vote on times, and chat - no account needed."
            : "Tell us your name and you can set something up and share the link - no account needed."}
        </p>
        <p className="muted small" style={{ maxWidth: 360, margin: 0 }}>
          By joining you agree to the <a href="/terms/" style={{ textDecoration: "underline" }}>Terms</a> and{" "}
          <a href="/privacy/" style={{ textDecoration: "underline" }}>Privacy Policy</a> and confirm you're at least 13.
        </p>
        <form className="row" style={{ maxWidth: 360, width: "100%" }} onSubmit={join}>
          <input className="input" maxLength={80} data-testid="guest-name" value={name} placeholder="Your name"
            onChange={(e) => setName(e.target.value)} />
          <button className="btn" data-testid="guest-join">Join</button>
        </form>
        {err && <p className="err">{err}</p>}
        {/* Existing users shouldn't have to join as a guest: sign in and land
            right back on this invite. */}
        {!DEV_AUTH && (
          <p className="muted small" style={{ margin: 0 }}>
            Already have an account?{" "}
            <a data-testid="guest-login" style={{ textDecoration: "underline" }}
              href={`/sign-in?redirect_url=${encodeURIComponent(window.location.pathname)}`}>
              Log in
            </a>
          </p>
        )}
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
  const showcase = ["📚 Book club", "🎲 D&D night", "🏃 Run club", "🎤 Karaoke night", "🎮 Game night", "🍽️ Dinner parties"];
  return (
    <div className="app">
      {/* Quiet top bar: brand left, sign-in right - the hero carries the page. */}
      <nav className="nav">
        <span className="brand" aria-label="Whensdays"><span className="dot" /><span className="word" /></span>
        {!DEV_AUTH && <a href="/sign-in" className="btn ghost sm" data-testid="sign-in">Sign in</a>}
      </nav>
      <div className="land">
        <h1 className="land-title">Your weekly meet ups,<br />handled.</h1>
        <p className="land-sub">
          Book club, run club, game night, karaoke - one link finds when the
          whole group is free, locks the winning dates as a series, and keeps
          the streak alive.
        </p>
        <div className="land-cta">
          <a href="/start" className="btn land-go" data-testid="start-plan">Get your link</a>
        </div>
        <p className="land-micro">Free · no account needed</p>
        <div className="land-showcase" aria-hidden>
          {showcase.map((s) => <span key={s} className="chip">{s}</span>)}
        </div>
        {/* The product is the pitch: a real event page + the group-availability
            heatmap with winning dates picked - one glance = how it works. */}
        <div className="land-shots">
          <img className="land-shot" src="/landing-shot.jpg" width={553} height={1200}
            alt="A Whensdays event: 9 of 9 friends in, one-tap RSVP" />
          <img className="land-shot land-shot-b" src="/landing-shot-2.jpg" width={553} height={1200}
            alt="Group availability from 9 people, two winning dates picked to schedule" />
        </div>
        <div className="land-points">
          <span><b>No app</b> to download</span>
          <span><b>No account</b> for the group to RSVP</span>
          <span><b>A whole series</b> locked at once, not one date</span>
        </div>
        {/* Support: a friendly line above the legal links (kept separate so
            feedback doesn't read as fine print). Subject prefill aids triage. */}
        <p className="muted small" style={{ textAlign: "center", marginTop: "2.4rem" }}>
          Questions, feedback, or something broken?{" "}
          <a href="mailto:support@whensdays.com?subject=Whensdays%20support" style={{ textDecoration: "underline" }}>
            support@whensdays.com
          </a>
        </p>
        {/* Visible privacy link on the homepage - required for Google OAuth
            app verification (a crawler-only link doesn't count). */}
        <p className="muted small" style={{ textAlign: "center", marginTop: "0.5rem" }}>
          <a href="/privacy/" style={{ textDecoration: "underline" }}>Privacy policy</a>{" · "}
          <a href="/terms/" style={{ textDecoration: "underline" }}>Terms</a>{" · "}
          <a href="/cookies/" style={{ textDecoration: "underline" }}>Cookies</a>
        </p>
      </div>
    </div>
  );
}

// Ensures the signed-in user has a minimal profile (name + handle) before using
// the app. A 404 from /api/profile means "not set up yet".
function ProfileGate({ canMerge }: { canMerge?: boolean }) {
  const api = useApi();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<"loading" | "needs-setup" | "ready">("loading");
  const [prefillName, setPrefillName] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    // Start the dashboard fetch NOW, in parallel with the profile fetch -
    // Home's useAsync consumes the in-flight promise instead of re-fetching,
    // cutting a serial API round trip out of first load.
    warmAsync(api, fetchDashboard);
    (async () => {
      // Guest → account merge: if a guest token lingers from before sign-up,
      // reassign that guest's plans/RSVPs to this account, then forget it.
      const g = canMerge ? storedGuest() : null;
      if (g) {
        try {
          const m = await api("/api/guest/merge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ guest_token: g.token }),
          });
          if (m.ok) { const b = await m.json(); if (b.name && !cancelled) setPrefillName(b.name); }
        } catch { /* best-effort */ }
        localStorage.removeItem(GUEST_KEY);
      }
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
  }, [api, canMerge]);

  // Tie analytics to the app user id (same id the API uses) once known.
  useEffect(() => {
    if (profile) analytics.identify(profile.user_id, { handle: profile.handle });
  }, [profile]);

  // The gate blocks on the profile fetch - show the real shell (brand + nav)
  // with skeleton tiles instead of a blank "Loading…" screen.
  if (state === "loading") return <Shell><ListSkeleton rows={4} header /></Shell>;
  if (state === "needs-setup")
    return (
      <Shell hideNav>
        <ProfileSetup
          prefillName={prefillName}
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
        <Suspense fallback={<ListSkeleton rows={3} header />}>
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
          <Route path="/gv/:id" element={<GroupPage />} />
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
          <span className="dot" /><span className="word" />
        </NavLink>
        {!hideNav && (
          <div className="nav-right">
            <div className="nav-links">
              <NavLink to="/" end>Events{badges.invites > 0 && <span className="dot-badge" data-testid="nav-badge-events">{badges.invites}</span>}</NavLink>
              <NavLink to="/friends">Friends{badges.friend_requests > 0 && <span className="dot-badge" data-testid="nav-badge-friends">{badges.friend_requests}</span>}</NavLink>
              <NavLink to="/groups">Groups</NavLink>
              <NavLink to="/calendars">Calendars</NavLink>
              <NavLink to="/profile">Profile</NavLink>
            </div>
            {DEV_AUTH && DEV_USER !== "demo-user" && <span className="pill polling" title="dev user (?as=…)">dev: {DEV_USER}</span>}
            {profile && (
              <NavLink to="/profile" title={profile.display_name} data-testid="nav-profile">
                <Avatar url={profile.avatar_url} name={profile.display_name} size={30} />
              </NavLink>
            )}
          </div>
        )}
      </nav>
      {/* Guest→account conversion nudge (K-factor): guests keep full access,
          but signing up preserves their plans across devices. */}
      {profile?.user_id.startsWith("guest_") && (
        <div className="card row between" data-testid="guest-banner" style={{ marginBottom: "0.9rem" }}>
          <span className="small">You're in as a guest - sign up to keep your plans on any device.</span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn ghost sm" data-testid="guest-reset"
              onClick={() => { localStorage.removeItem(GUEST_KEY); location.href = "/"; }}>Start over</button>
            <GuestSignupButton testid="guest-signup" source="banner" />
          </span>
        </div>
      )}
      {children}
      {!hideNav && <TabBar badges={badges} />}
    </div>
  );
}

// Bottom tab bar for mobile (CSS hides it on wider screens). Same destinations
// as the top nav, as icon + label - inspired by app-style bottom navigation.
// Discover is deliberately NOT here (roadmap: no public social surface before
// group density - empty rooms kill trust). Its routes stay live for direct
// links; re-add the tab when there's density to show.
const TABS = [
  { to: "/", id: "events", label: "Events", end: true, icon: IconHome },
  { to: "/friends", id: "friends", label: "Friends", icon: IconFriends },
  { to: "/groups", id: "groups", label: "Groups", icon: IconGroups },
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
// IconCompass belonged to the Discover tab - kept for when Discover returns to
// the nav (see the TABS comment); referenced here so strict TS keeps it.
void IconCompass;
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
