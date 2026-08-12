import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Event, Group, GroupDetail, PublicPage, collapseSeries, eventIsPast, seriesCounts, fmtDateTime, getJSON, sendJSON, useApi } from "../lib";

// One-time "your old links are view-only now" note (see the Share card).
const LINK_HINT_KEY = "whensdays.groupLinkHint";

// Consecutive months (ending now, with a one-month grace) in which the group
// had at least one scheduled event - the ritual streak. Loss aversion is the
// retention mechanic: breaking it should feel like a loss.
function groupStreak(events: Event[]): number {
  const months = new Set(
    events.filter((e) => e.starts_at && e.status === "scheduled")
      .map((e) => { const d = new Date(e.starts_at!); return d.getFullYear() * 12 + d.getMonth(); }),
  );
  const now = new Date();
  let m = now.getFullYear() * 12 + now.getMonth();
  if (!months.has(m)) m -= 1; // grace: alive if last month had one
  let n = 0;
  while (months.has(m)) { n++; m--; }
  return n;
}
import { Avatar, BackLink, ConfirmButton, FollowButton, GifPicker, ListSkeleton, QRButton, fileToAvatar, useAsync, EventThumb } from "../ui";
import { Ic } from "../Icons";

// Group icon: uploaded photo wins over monogram fallback.
function GroupIcon({ group, size = 44 }: { group: Group; size?: number }) {
  if (group.icon_url) return <Avatar url={group.icon_url} name={group.name} size={size} />;
  // Monogram: first letter of group name, or empty placeholder (Phase 3: TitlePoster).
  const initial = group.name.charAt(0).toUpperCase() || "·";
  return <span style={{ fontSize: size * 0.5, fontWeight: 700, display: "grid", placeItems: "center", width: size, height: size, background: "var(--plum)", color: "var(--cream)", borderRadius: "var(--r-xs)" }}>{initial}</span>;
}

type GroupsResp = { groups: Group[] };

export function Groups() {
  const api = useApi();
  const nav = useNavigate();
  const { data, loading, reload } = useAsync<GroupsResp>((a) => getJSON(a, "/api/groups"));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    // No icon at creation - the server defaults the emoji to 👥; a photo/GIF can
    // be added from the group page afterward.
    const res = await sendJSON(api, "POST", "/api/groups", { name, description });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setMsg(b.error || "could not create");
    }
    setName("");
    setDescription("");
    reload();
  }

  // No full-page loader: the create form renders instantly; the list area
  // shows skeleton tiles until the first fetch lands.
  return (
    <div className="stack">
      <h1>Groups</h1>

      <form className="card stack" onSubmit={create}>
        <label className="field" htmlFor="gn">Create a group</label>
        <div className="row">
          <input
            id="gn"
            className="input"
            maxLength={80} data-testid="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
          />
          <button className="btn" data-testid="group-create">Create</button>
        </div>
        <textarea className="input" maxLength={500} data-testid="group-desc" value={description} rows={2}
          placeholder="What's this group about? (optional)" onChange={(e) => setDescription(e.target.value)} />
        <p className="muted small" style={{ margin: 0 }}>Add a photo or GIF from the group page after creating.</p>
        {msg && <p className="muted small">{msg}</p>}
      </form>

      <div className="section-h">Your groups</div>
      {loading && !data && <ListSkeleton rows={3} />}
      {data && data.groups.length === 0 && (
        <p className="muted small">No groups yet - make one for your people.</p>
      )}
      {data?.groups.map((g) => (
        <div
          key={g.id}
          className="card row between"
          data-testid="group-row"
          style={{ cursor: "pointer" }}
          onClick={() => nav(`/g/${g.id}`)}
        >
          <span className="row" style={{ gap: 8 }}>
            <GroupIcon group={g} />
            <span>{g.name}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// The invite token turns a link into a JOIN link. It rides the URL as
// ?invite=…; a bare group link is public and view-only.
export function inviteTokenFromURL(): string {
  return new URLSearchParams(window.location.search).get("invite") || "";
}

// GroupPublicView - what a NON-MEMBER sees at /g/{id}: the public page. Name,
// icon, description, member count, and the group's upcoming LISTED events, plus
// Follow. There is no join affordance here unless the visitor arrived on an
// invite link (viewer.can_join, server-verified) - the bare link buys a view,
// not a seat. Works with no account at all: the endpoint is unauthenticated, so
// `signedOut` visitors get a sign-up nudge in place of Follow/Join.
export function GroupPublicView({ id, signedOut, onJoined }: { id: string; signedOut?: boolean; onJoined: () => void }) {
  const api = useApi();
  const nav = useNavigate();
  const invite = inviteTokenFromURL();
  const { data, loading } = useAsync<PublicPage>(
    (a) => getJSON(a, `/api/public/groups/${id}${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`), [id, invite]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (loading && !data) return <ListSkeleton rows={1} header />;
  if (!data) return <div className="stack"><BackLink /><p className="muted">Group not found.</p></div>;
  const { entity, viewer } = data;
  const isGuest = viewer.id.startsWith("guest_");
  async function join() {
    setBusy(true);
    // The token also rides the POST body - the button is UI, the server
    // re-verifies the capability on the write.
    const res = await sendJSON(api, "POST", `/api/groups/${id}/join`, { invite });
    setBusy(false);
    if (!res.ok) return setErr("that invite link is no longer valid - ask for a new one");
    onJoined();
  }
  return (
    <div className="stack">
      <div className="card stack" style={{ alignItems: "center", textAlign: "center" }} data-testid="group-public-card">
        {entity.icon_url ? <Avatar url={entity.icon_url} name={entity.name} size={72} /> : (() => { const initial = entity.name.charAt(0).toUpperCase() || "·"; return <span style={{ fontSize: "2rem", fontWeight: 700, width: 72, height: 72, display: "grid", placeItems: "center", background: "var(--plum)", color: "var(--cream)", borderRadius: "var(--r-sm)" }}>{initial}</span>; })()}
        <h1 data-testid="group-public-title">{entity.name}</h1>
        <p className="muted small">{entity.member_count} {entity.member_count === 1 ? "member" : "members"}</p>
        {entity.description && <p className="muted small" style={{ maxWidth: 420 }}>{entity.description}</p>}
        {/* Join shows ONLY on an invite link (the server decides). */}
        {viewer.can_join && (
          <button className="btn" data-testid="group-join" disabled={busy} onClick={join}>
            {busy ? "Joining…" : "Join this group"}
          </button>
        )}
        {/* You can FOLLOW a club without joining it - their listed events then
            show up in your feed. Following needs an account: signed-out
            visitors and guests get the signup nudge instead. */}
        {signedOut || isGuest ? (
          <span className="stack" style={{ gap: 4, alignItems: "center" }}>
            <a className="btn soft" href="/sign-up" data-testid="group-follow-signup">+ Follow</a>
            <span className="muted small">Sign up to follow - their plans then land in your feed.</span>
          </span>
        ) : (
          <span className="stack" style={{ gap: 4, alignItems: "center" }}>
            <FollowButton kind="group" value={id} following={viewer.is_following}
              source="group_public" testid="group-follow" size="" />
            <span className="muted small">Not joining? Follow to see their plans in your feed.</span>
          </span>
        )}
        {err && <p className="muted small" data-testid="group-join-err">{err}</p>}
      </div>

      {data.events.length > 0 && (
        <>
          <div className="section-h">What's coming up</div>
          {collapseSeries([...data.events], "next")
            .sort((a, b) => new Date(a.starts_at || 0).getTime() - new Date(b.starts_at || 0).getTime())
            .map((e) => (
              <GroupEventRow key={e.id} event={e} onClick={() => nav(`/e/${e.id}`)}
                testid="group-public-event"
                seriesN={e.series_id ? (seriesCounts(data.events)[e.series_id] ?? 1) : 0} />
            ))}
        </>
      )}
    </div>
  );
}

export function GroupPage() {
  const { id } = useParams();
  const api = useApi();
  const nav = useNavigate();
  const { data, loading, reload } = useAsync<GroupDetail>((a) => getJSON(a, `/api/groups/${id}`), [id]);
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickingGif, setPickingGif] = useState(false);
  // One-time rollout note about old links (see the Share card below).
  const [linkHintSeen, setLinkHintSeen] = useState(() => {
    try { return localStorage.getItem(LINK_HINT_KEY) === "1"; } catch { return true; }
  });

  async function onPickIcon(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToAvatar(file);
      const res = await sendJSON(api, "PUT", `/api/groups/${id}/icon`, { icon_url: dataUrl });
      if (res.ok) reload();
    } catch {
      setAddMsg("could not read image");
    }
  }

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  async function saveGroup(e: React.FormEvent) {
    e.preventDefault();
    const res = await sendJSON(api, "PUT", `/api/groups/${id}`, { name: editName, description: editDesc });
    if (!res.ok) { const b = await res.json().catch(() => ({})); return setAddMsg(b.error || "could not save"); }
    setEditing(false);
    reload();
  }

  if (loading && !data) return <ListSkeleton rows={4} header />;
  // Not a member: the group's PUBLIC page (view + follow). Joining needs an
  // invite link - the bare id is not a membership capability.
  if (!data) return <GroupPublicView id={id!} onJoined={reload} />;

  const { group, members, events, is_owner, is_admin, viewer_id, invite_token: inviteToken } = data;
  // The list shows only what's still happening: no past occurrences, and a
  // cancelled event never lingers even if a stale cached response carries one.
  const upcomingEvents = events.filter((e) => e.status !== "cancelled" && !eventIsPast(e));
  const canManage = is_owner || is_admin;
  // TWO links, and the difference matters: the bare one is a public page
  // (view + follow), the ?invite= one grants MEMBERSHIP (members see the member
  // list and every group event). ?from=<me> is share attribution only - it lets
  // the unfurl say "<name> invited you to join" (the server checks the id is a
  // real member before showing any name) and authorizes nothing.
  const from = `from=${encodeURIComponent(viewer_id)}`;
  const shareURL = `${location.origin}/g/${group.id}?${from}`;
  const inviteURL = `${location.origin}/g/${group.id}?invite=${encodeURIComponent(inviteToken)}&${from}`;
  // Rollout reality #2: every event created before migration 0044 is
  // listed=false, so an established group's public page can look empty. Say so,
  // and offer the one-tap fix.
  const unlisted = upcomingEvents.filter((e) => !e.listed);

  return (
    <div className="stack">
      <BackLink />

      <div className="card stack">
        <div className="card-header">
          <span className="row" style={{ gap: 10, minWidth: 0 }}>
            <GroupIcon group={group} size={64} />
            <span className="stack" style={{ gap: 4, minWidth: 0 }}>
              <h1 data-testid="group-title">{group.name}</h1>
              {groupStreak(events) >= 2 && (
                <span className="pill polling" data-testid="group-streak" style={{ alignSelf: "flex-start" }}>
                  {groupStreak(events)}-month streak
                </span>
              )}
            </span>
          </span>
          {!editing && (
            <span className="row card-actions" style={{ gap: 6 }}>
              {/* Following is separate from membership: a member can follow too
                  (their feed then carries the group's listed events). Kept small
                  and first so it never competes with the member/admin actions. */}
              {!viewer_id.startsWith("guest_") && (
                <FollowButton kind="group" value={group.id} following={data.is_following}
                  source="group_page" testid="group-follow" />
              )}
              {canManage && (
                <>
                  <button type="button" className="btn ghost sm" data-testid="group-edit"
                    onClick={() => { setEditName(group.name); setEditDesc(group.description); setEditing(true); }}>Edit</button>
                  <button className="btn sm" data-testid="group-new-event"
                    onClick={() => nav(`/new?group=${group.id}`)}>+ New event</button>
                </>
              )}
            </span>
          )}
        </div>
        {group.description && !editing && (
          <p className="muted" data-testid="group-description" style={{ overflowWrap: "anywhere" }}>{group.description}</p>
        )}
        {editing && (
          <form className="stack" style={{ gap: 8 }} onSubmit={saveGroup} data-testid="group-edit-form">
            <input className="input" maxLength={80} data-testid="group-edit-name" value={editName}
              placeholder="Group name" onChange={(e) => setEditName(e.target.value)} />
            <textarea className="input" maxLength={500} data-testid="group-edit-desc" value={editDesc} rows={2}
              placeholder="What's this group about? (optional)" onChange={(e) => setEditDesc(e.target.value)} />
            {/* Icon + delete only live in edit mode (owner) - not clutter on the
                default view. */}
            {is_owner && (
              <div className="row wrap" style={{ gap: 6 }}>
                <button type="button" className="btn ghost sm" data-testid="group-icon-pick"
                  onClick={() => fileRef.current?.click()}>
                  {group.icon_url ? "Change photo" : "Use a photo"}
                </button>
                <input ref={fileRef} type="file" accept="image/*" data-testid="group-icon-file"
                  style={{ display: "none" }} onChange={onPickIcon} />
                <button type="button" className="btn ghost sm" data-testid="group-icon-gif"
                  onClick={() => setPickingGif((p) => !p)}>GIF</button>
              </div>
            )}
            {is_owner && pickingGif && (
              <GifPicker onPick={async (url) => {
                await sendJSON(api, "PUT", `/api/groups/${id}/icon`, { icon_url: url });
                setPickingGif(false);
                reload();
              }} />
            )}
            <div className="row between">
              <span className="row" style={{ gap: 6 }}>
                <button className="btn sm" data-testid="group-edit-save">Save</button>
                <button type="button" className="btn ghost sm" data-testid="group-edit-cancel" onClick={() => setEditing(false)}>Cancel</button>
              </span>
              {is_owner && (
                <ConfirmButton label="Delete group" confirmLabel="Tap again - events stay, group goes" testid="group-delete"
                  onConfirm={async () => { await api(`/api/groups/${id}`, { method: "DELETE" }); nav("/groups"); }} />
              )}
            </div>
            {addMsg && <p className="muted small" style={{ margin: 0 }}>{addMsg}</p>}
          </form>
        )}
      </div>

      {/* Sharing lives in its own box, and it is TWO different things. Making
          the distinction unmissable is the whole point: a host must never hand
          out membership when they only meant to share the page. */}
      <div className="card stack" style={{ gap: 14 }}>
        <div className="section-h" style={{ margin: 0 }}>Share</div>

        {/* Rollout reality #1: links shared before this change were join links
            and are now view-only. Small, one-time, dismissible. */}
        {canManage && !linkHintSeen && (
          <div className="row between" data-testid="group-link-hint"
            style={{ gap: 8, alignItems: "flex-start", background: "var(--glass-2)", border: "1px solid var(--glass-line)", borderRadius: "var(--radius-sm)", padding: "0.55rem 0.7rem" }}>
            <span className="muted small">
              Heads up: links you shared before now open the <b>public page</b> only. To add someone as a member, send the <b>Invite to join</b> link below.
            </span>
            <button type="button" className="btn ghost sm" data-testid="group-link-hint-dismiss"
              aria-label="Dismiss" onClick={() => { localStorage.setItem(LINK_HINT_KEY, "1"); setLinkHintSeen(true); }}>{Ic.x()}</button>
          </div>
        )}

        <div className="stack" style={{ gap: 6 }}>
          <div className="row between" style={{ gap: 6 }}>
            <b>Share page</b>
            <span className="pill">public</span>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Anyone can open it: what the group is and what's coming up. They can follow, <b>not</b> join.
          </p>
          <button type="button" className="share-copy" data-testid="group-share-copy" title="Tap to copy"
            onClick={() => { navigator.clipboard?.writeText(shareURL); setCopyMsg("Public page link copied"); }}>
            {shareURL.replace(/^https?:\/\//, "")}
          </button>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <div className="row between" style={{ gap: 6 }}>
            <b>Invite to join</b>
            <span className="pill scheduled">members</span>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Grants membership: they'll see every event and the member list. Send it to people you actually want in.
          </p>
          <button type="button" className="share-copy" data-testid="group-invite-copy" title="Tap to copy"
            onClick={() => { navigator.clipboard?.writeText(inviteURL); setCopyMsg("Invite link copied"); }}>
            {copyMsg === "Invite link copied" ? "Copied" : "Copy the invite link"}
          </button>
          <div className="row wrap" style={{ gap: 6 }}>
            {/* QR belongs to the JOIN link - it's the in-person "scan this to
                join the club" moment. */}
            <QRButton url={inviteURL} testid="group-qr" label="QR to join" />
            {canManage && (
              <ConfirmButton label="Regenerate" confirmLabel="Tap again - old invite links stop working"
                testid="group-invite-rotate"
                onConfirm={async () => {
                  await sendJSON(api, "POST", `/api/groups/${id}/invite/rotate`, {});
                  setCopyMsg("New invite link - the old one no longer works");
                  reload();
                }} />
            )}
          </div>
        </div>
        {copyMsg && <p className="muted small" style={{ margin: 0 }} data-testid="group-share-msg">{copyMsg}</p>}
      </div>

      {/* Rollout reality #2: pre-0044 events are all listed=false, so the
          public page can read as broken. Count them and offer the fix. */}
      {canManage && unlisted.length > 0 && (
        <div className="card stack" style={{ gap: 6 }} data-testid="group-unlisted-hint">
          <span className="muted small">
            {unlisted.length} upcoming {unlisted.length === 1 ? "event isn't" : "events aren't"} shown on your public page.
          </span>
          <span className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn soft sm" data-testid="group-unlisted-fix"
              onClick={async () => {
                await Promise.all(unlisted.map((e) => sendJSON(api, "PUT", `/api/events/${e.id}/listed`, { listed: true })));
                reload();
              }}>
              Show {unlisted.length === 1 ? "it" : "them"} publicly
            </button>
          </span>
        </div>
      )}

      {/* Compact members summary (Instagram-style): a few faces + a count that
          opens the dedicated members page - the full list no longer floods the
          main group scroll. */}
      <Link to={`/g/${group.id}/members`} className="card row between" data-testid="group-members-link"
        style={{ cursor: "pointer", textDecoration: "none", color: "inherit" }}>
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          {members.length > 0 && (
            <span className="facepile" style={{ marginTop: 0 }}>
              {members.slice(0, 5).map((m) => (
                <span key={m.user_id} className="face" title={m.display_name || m.handle || ""}>
                  <Avatar url={m.avatar_url} name={m.display_name} size={28} />
                </span>
              ))}
            </span>
          )}
          <span className="muted small">
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
        </span>
        <span className="muted" aria-hidden="true">›</span>
      </Link>

      {upcomingEvents.length > 0 && (
        <>
          <div className="section-h">Events</div>
          {/* A recurring series shows once (its next occurrence + a badge
              counting its REMAINING dates), not one tile per date. Past
              occurrences and cancelled events don't show here at all (the
              streak above still reads the full history). */}
          {collapseSeries([...upcomingEvents], "next")
            .sort((a, b) => new Date(a.starts_at || 0).getTime() - new Date(b.starts_at || 0).getTime())
            .map((e) => (
              <GroupEventRow key={e.id} event={e} onClick={() => nav(`/e/${e.id}`)}
                seriesN={e.series_id ? (seriesCounts(upcomingEvents)[e.series_id] ?? 1) : 0} />
            ))}
        </>
      )}
    </div>
  );
}

// Dedicated members page (reached from the compact summary on the group page).
// Full member list + admin controls live here so the main group page stays a
// calm summary that scales to hundreds of members.
export function GroupMembersPage() {
  const { id } = useParams();
  const api = useApi();
  // Same fetcher as GroupPage - useAsync caches by fetcher+deps, so arriving
  // here from the group page is instant (stale-while-revalidate).
  const { data, loading, reload } = useAsync<GroupDetail>((a) => getJSON(a, `/api/groups/${id}`), [id]);
  const [handle, setHandle] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    setAddMsg(null);
    const res = await sendJSON(api, "POST", `/api/groups/${id}/members`, { handle });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setAddMsg(b.error || "could not add");
    }
    setHandle("");
    reload();
  }
  async function setRole(userId: string, role: "member" | "admin") {
    await sendJSON(api, "PUT", `/api/groups/${id}/members/${userId}/role`, { role });
    reload();
  }
  async function removeMember(userId: string) {
    await api(`/api/groups/${id}/members/${userId}`, { method: "DELETE" });
    reload();
  }

  if (loading && !data) return <ListSkeleton rows={4} header />;
  if (!data) return <div className="stack"><BackLink /><p className="muted">Group not found.</p></div>;

  const { group, members, is_owner, is_admin } = data;
  const canManage = is_owner || is_admin;

  return (
    <div className="stack">
      <Link to={`/g/${group.id}`} className="muted small" style={{ display: "inline-block", marginBottom: "0.6rem" }}>
        
      </Link>

      <div className="section-h">Members</div>
      {members.length === 0 && <p className="muted small">No members yet - add someone below.</p>}
      {members.map((m) => {
        const isGroupOwner = m.user_id === group.owner_id;
        return (
          // Two rows so the action buttons can never collide with the name:
          // identity on top, management actions right-aligned underneath.
          <div key={m.user_id} className="card stack" style={{ gap: 8 }} data-testid="group-member">
            <div className="row" style={{ gap: 8, minWidth: 0, flexWrap: "wrap" }}>
              <Avatar url={m.avatar_url} name={m.display_name} size={32} />
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {m.display_name || m.handle}
                {m.handle && <span className="muted small"> @{m.handle}</span>}
              </span>
              {(isGroupOwner || m.role === "admin") && (
                <span className="pill scheduled" data-testid={`member-admin-${m.handle}`}>{isGroupOwner ? "Owner" : "Admin"}</span>
              )}
            </div>
            {canManage && !isGroupOwner && (
              <div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button className="btn ghost sm" data-testid={`member-role-${m.handle}`}
                  onClick={() => setRole(m.user_id, m.role === "admin" ? "member" : "admin")}>
                  {m.role === "admin" ? "Remove admin" : "Make admin"}
                </button>
                <ConfirmButton label="Remove" confirmLabel="Tap again to remove" testid={`member-remove-${m.handle}`}
                  onConfirm={() => removeMember(m.user_id)} />
              </div>
            )}
          </div>
        );
      })}

      {canManage && (
        <form className="card stack" onSubmit={addMember}>
          <label className="field" htmlFor="mh">Add a member by handle</label>
          <div className="row">
            <input
              id="mh"
              className="input"
              maxLength={40} data-testid="member-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="handle"
            />
            <button className="btn" data-testid="member-add">Add</button>
          </div>
          {addMsg && <p className="muted small">{addMsg}</p>}
        </form>
      )}
    </div>
  );
}

function GroupEventRow({ event, onClick, seriesN, testid = "group-event" }: { event: Event; onClick: () => void; seriesN?: number; testid?: string }) {
  return (
    <div
      className={`card ev tile ${event.theme ? `theme-tile theme-${event.theme}` : "type-tile"}`}
      data-testid={testid}
      style={{ cursor: "pointer" }}
      onClick={onClick}
    >
      {event.photo_url && <EventThumb photo={event.photo_url} size={64} />}
      <div style={{ flex: 1 }}>
        <div className="title">{event.title}</div>
        <div className="muted small">
          {event.status === "polling" ? "Finding a time" : fmtDateTime(event.starts_at)}
          {seriesN && seriesN > 1 ? <span data-testid="series-badge"> · {seriesN} dates</span> : null}
        </div>
      </div>
    </div>
  );
}
