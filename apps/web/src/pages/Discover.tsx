import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CATEGORIES, CITY_OPTIONS, Follow, PublicEvent, fmtDateTime, sendJSON, useApi, useProfile } from "../lib";
import { Avatar, EventThumb } from "../ui";
import { EVENTS, analytics } from "../analytics";
import { Ic } from "../Icons";

// Discover: browse upcoming PUBLIC events by topic or city, and (signed in)
// follow hosts/topics to build a feed. The browse API is unauthenticated, so
// this page also renders for signed-out visitors (see PublicDiscover in App).
export function Discover() {
  const profile = useProfile(); // null when rendered signed-out
  const api = useApi();
  const nav = useNavigate();

  const [topic, setTopic] = useState(""); // a preset category slug, or ""
  const [city, setCity] = useState(""); // FILTER default: empty (a tz prefill here silently hides everything else)
  const [scope, setScope] = useState<"public" | "friends">("public"); // For-you source
  const [events, setEvents] = useState<PublicEvent[] | null>(null);
  const [feed, setFeed] = useState<PublicEvent[]>([]);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [activeTopics, setActiveTopics] = useState<string[]>([]);

  // Browse: the public endpoint signed-out; the authed twin adds per-viewer
  // annotations (friends going, your RSVP, friend-hosted) for tile styling.
  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (topic) p.set("topic", topic);
    if (city.trim()) p.set("city", city.trim());
    const res = profile
      ? await api(`/api/discover/mine?${p.toString()}`)
      : await fetch(`/api/discover?${p.toString()}`);
    if (res.ok) {
      const b = await res.json();
      setEvents(b.events ?? []);
      setActiveTopics(b.topics ?? []);
    }
  }, [topic, city, profile, api]);
  useEffect(() => {
    load();
  }, [load]);

  // Ranked "For you" feed - only when signed in; scope switches between all
  // public events and events your friends are hosting.
  const loadFeed = useCallback(async () => {
    if (!profile) return;
    const res = await api(`/api/feed?scope=${scope}`);
    if (res.ok) {
      const b = await res.json();
      setFeed(b.events ?? []);
      setFollows(b.follows ?? []);
    }
  }, [api, profile, scope]);
  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  // "For you" is a top-5 highlights rail (hidden while filtering); the browse
  // list below excludes whatever the rail shows so nothing appears twice.
  const filtering = !!topic || !!city.trim();
  const forYou = filtering ? [] : feed.slice(0, 5);
  const railIds = new Set(forYou.map((e) => e.id));
  const browse = (events ?? []).filter((e) => !railIds.has(e.id));

  const following = (kind: string, value: string) => follows.some((f) => f.kind === kind && f.value === value);
  async function toggleFollow(kind: "host" | "topic", value: string) {
    if (following(kind, value)) {
      await api(`/api/follows/${kind}/${encodeURIComponent(value)}`, { method: "DELETE" });
    } else {
      await sendJSON(api, "POST", "/api/follows", { kind, value });
      analytics.capture(EVENTS.followed, { kind });
    }
    loadFeed();
  }

  return (
    <div className="stack">
      <h1>Discover</h1>
      <p className="muted small">Public Whensdays anyone can join - streams, meetups, game nights. Filter by topic or city.</p>

      {/* Only categories that currently have an upcoming public event render
          (the selected one stays visible so it can be unselected). */}
      <div className="row wrap" style={{ gap: 4 }}>
        {CATEGORIES.filter((c) => activeTopics.includes(c.slug) || topic === c.slug).map((c) => (
          <button key={c.slug} type="button" className={`chip sm ${topic === c.slug ? "on" : ""}`}
            data-testid={`disc-cat-${c.slug}`}
            onClick={() => setTopic(topic === c.slug ? "" : c.slug)}>{c.label}</button>
        ))}
      </div>
      <div className="row">
        <input className="input" maxLength={60} data-testid="disc-city" list="disc-city-list" value={city}
          placeholder="city" onChange={(e) => setCity(e.target.value)} />
        <datalist id="disc-city-list">
          {CITY_OPTIONS.map((c) => <option key={c} value={c} />)}
        </datalist>
        {city && <button type="button" className="btn ghost sm" data-testid="disc-city-clear" onClick={() => setCity("")} title="Clear">{Ic.x()}</button>}
      </div>

      {profile && !topic && !city.trim() && (
        <>
          <div className="row between">
            <div className="section-h" style={{ margin: 0 }}>For you</div>
            <div className="row" style={{ gap: 4 }}>
              <button type="button" className={`chip sm ${scope === "public" ? "on" : ""}`}
                data-testid="scope-public" onClick={() => setScope("public")}>Public</button>
              <button type="button" className={`chip sm ${scope === "friends" ? "on" : ""}`}
                data-testid="scope-friends" onClick={() => setScope("friends")}>Friends</button>
            </div>
          </div>
          {feed.length === 0 && (
            <p className="muted small" data-testid="feed-empty">
              {scope === "friends" ? "No upcoming events from your friends yet." : "Nothing for you yet - follow a host or topic below."}
            </p>
          )}
          {forYou.map((e) => (
            <PublicEventRow key={`f-${e.id}`} e={e} onOpen={() => nav(`/e/${e.id}`)}
              canFollow={!!profile} following={following} toggleFollow={toggleFollow} viewerId={profile?.user_id} testid="feed-event" />
          ))}
        </>
      )}

      <div className="section-h">Upcoming events</div>
      {browse.length === 0 && events && <p className="muted small" data-testid="disc-empty">{forYou.length > 0 ? "That's everything - see For you above." : "Nothing public yet - host one and set it to Public!"}</p>}
      {browse.map((e) => (
        <PublicEventRow key={e.id} e={e} onOpen={() => nav(`/e/${e.id}`)}
          canFollow={!!profile} following={following} toggleFollow={toggleFollow} viewerId={profile?.user_id} testid="disc-event" />
      ))}
    </div>
  );
}

function PublicEventRow({ e, onOpen, canFollow, following, toggleFollow, viewerId, testid }: {
  e: PublicEvent;
  onOpen: () => void;
  canFollow: boolean;
  following: (kind: string, value: string) => boolean;
  toggleFollow: (kind: "host" | "topic", value: string) => void;
  viewerId?: string;
  testid: string;
}) {
  // "You're going" reads from the pill in the row itself now - the whole-tile
  // glow tiers (tile-going/tile-friend) were exactly the gradient-wash "AI
  // SaaS" language House Lights removes (§9); tiles are flat, same as Home.
  const going = e.viewer_rsvp === "going" || e.host_id === viewerId;

  return (
    // NOT .tile here - .tile's flex-row layout is for Home/Groups' single-row
    // tiles (paired with .ev, which already wins that layout); this card is a
    // richer two-row stack (thumb+title row, then host+follow row) and only
    // wants .tile's SIBLING concerns: the flat --surface card + the themed
    // bottom edge.
    <div className={`card stack ${e.theme ? `theme-tile theme-${e.theme}` : ""}`} data-testid={testid}
      style={{ gap: 6 }}>
      <div className="row between">
        {/* flex:auto inline (beats the ".row.between > .row" nowrap/flex:none
            rule meant for right-pinned action clusters, not this left-side
            thumb+title cluster) so a long title shrinks instead of shoving
            the category tag off the card on a phone. */}
        <span className="row" style={{ gap: 10, cursor: "pointer", minWidth: 0, flex: "1 1 auto" }} onClick={onOpen}>
          <EventThumb photo={e.photo_url} title={e.title} size={64} />
          <span className="stack" style={{ gap: 1, minWidth: 0 }}>
            <strong style={{ overflowWrap: "anywhere" }}>{e.title}</strong>
            <span className="muted small">
              <span className="stamp time">{fmtDateTime(e.starts_at)}</span>
              {e.city ? ` · ${e.city}` : ""}
              {going && <span className="pill scheduled" style={{ marginLeft: 6 }}>You're going</span>}
            </span>
          </span>
        </span>
        {e.topic && (
          // A plain category label (not interactive) - filtering by category
          // is done with the chips at the top of the page.
          <span className="cat-tag" data-testid={`cat-tag-${e.topic}`}>
            {CATEGORIES.find((c) => c.slug === e.topic)?.label ?? e.topic}
          </span>
        )}
      </div>
      <div className="row between">
        <span className="row small" style={{ gap: 6 }}>
          <Avatar url={e.host_avatar} name={e.host_name} size={22} />
          <span className="muted">{e.host_name || "A host"}</span>
          {e.friends_going > 0 && (
            <span className="friends-going" data-testid="friends-going" title="Friends going">
              {e.friends_going} friend{e.friends_going > 1 ? "s" : ""} going
            </span>
          )}
        </span>
        {canFollow && e.host_id !== viewerId && (
          <button type="button" className="btn ghost sm" data-testid="follow-host"
            onClick={() => toggleFollow("host", e.host_id)}>
            {following("host", e.host_id) ? <span className="row" style={{ gap: "0.35rem", alignItems: "center" }}>{Ic.check(15)}Following</span> : "Follow host"}
          </button>
        )}
      </div>
    </div>
  );
}
