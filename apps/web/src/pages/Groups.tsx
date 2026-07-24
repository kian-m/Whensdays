import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Event, Group, GroupDetail, collapseSeries, eventIsPast, seriesCounts, fmtDateTime, getJSON, sendJSON, useApi } from "../lib";

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
import { Avatar, BackLink, ConfirmButton, GifPicker, ListSkeleton, QRButton, fileToAvatar, useAsync, EventThumb } from "../ui";

// Group icon: uploaded photo wins over emoji.
function GroupIcon({ group, size = 44 }: { group: Group; size?: number }) {
  if (group.icon_url) return <Avatar url={group.icon_url} name={group.name} size={size} />;
  return <span style={{ fontSize: size * 0.72 }}>{group.emoji || "👥"}</span>;
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

type GroupPreview = { id: string; name: string; description: string; emoji: string; icon_url: string; member_count: number; is_member: boolean };

// The join view anyone (guests included) sees when they open a group link
// they're not a member of yet.
function GroupJoin({ id, onJoined }: { id: string; onJoined: () => void }) {
  const api = useApi();
  const { data, loading } = useAsync<GroupPreview>((a) => getJSON(a, `/api/groups/${id}/preview`), [id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (loading && !data) return <ListSkeleton rows={1} header />;
  if (!data) return <div className="stack"><BackLink /><p className="muted">Group not found.</p></div>;
  async function join() {
    setBusy(true);
    const res = await sendJSON(api, "POST", `/api/groups/${id}/join`, {});
    setBusy(false);
    if (!res.ok) return setErr("could not join - try again");
    onJoined();
  }
  return (
    <div className="stack">
      <div className="card stack" style={{ alignItems: "center", textAlign: "center" }} data-testid="group-join-card">
        {data.icon_url ? <Avatar url={data.icon_url} name={data.name} size={72} /> : <span style={{ fontSize: "3rem" }}>{data.emoji || "👥"}</span>}
        <h1>{data.name}</h1>
        <p className="muted small">{data.member_count} {data.member_count === 1 ? "member" : "members"} · you're invited to join</p>
        {data.description && <p className="muted small" style={{ maxWidth: 420 }}>{data.description}</p>}
        <button className="btn" data-testid="group-join" disabled={busy} onClick={join}>
          {busy ? "Joining…" : "Join the group"}
        </button>
        {err && <p className="muted small">{err}</p>}
      </div>
    </div>
  );
}

export function GroupPage() {
  const { id } = useParams();
  const api = useApi();
  const nav = useNavigate();
  const { data, loading, reload } = useAsync<GroupDetail>((a) => getJSON(a, `/api/groups/${id}`), [id]);
  const [handle, setHandle] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickingGif, setPickingGif] = useState(false);

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
  async function setRole(userId: string, role: "member" | "admin") {
    await sendJSON(api, "PUT", `/api/groups/${id}/members/${userId}/role`, { role });
    reload();
  }
  async function removeMember(userId: string) {
    await api(`/api/groups/${id}/members/${userId}`, { method: "DELETE" });
    reload();
  }

  if (loading && !data) return <ListSkeleton rows={4} header />;
  // Not a member (or arriving fresh from an invite link): the link is the
  // capability - show a preview + Join instead of a wall.
  if (!data) return <GroupJoin id={id!} onJoined={reload} />;

  const { group, members, events, is_owner, is_admin, viewer_id } = data;
  // The list shows only what's still happening: no past occurrences, and a
  // cancelled event never lingers even if a stale cached response carries one.
  const upcomingEvents = events.filter((e) => e.status !== "cancelled" && !eventIsPast(e));
  const canManage = is_owner || is_admin;
  // ?from=<me> lets the unfurl say "<name> invited you to join" (server checks
  // the id is a real member before showing any name).
  const inviteURL = `${location.origin}/g/${group.id}?from=${encodeURIComponent(viewer_id)}`;

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
                  🔥 {groupStreak(events)}-month streak
                </span>
              )}
            </span>
          </span>
          {canManage && !editing && (
            <span className="row card-actions" style={{ gap: 6 }}>
              <button type="button" className="btn ghost sm" data-testid="group-edit"
                onClick={() => { setEditName(group.name); setEditDesc(group.description); setEditing(true); }}>✎ Edit</button>
              <button className="btn sm" data-testid="group-new-event"
                onClick={() => nav(`/new?group=${group.id}`)}>+ New event</button>
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
          </form>
        )}
      </div>

      {/* Invite lives in its own box - any member can grow the group (the link
          IS the invite). */}
      <div className="card stack" style={{ gap: 8 }}>
        <div className="section-h" style={{ margin: 0 }}>Invite people</div>
        <p className="muted small" style={{ margin: 0 }}>Anyone with the link can preview the group and join in one tap.</p>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn soft sm" data-testid="group-invite-copy"
            onClick={() => { navigator.clipboard?.writeText(inviteURL); setCopyMsg("Invite link copied ✓"); }}>
            🔗 Invite via link
          </button>
          <QRButton url={inviteURL} testid="group-qr" />
        </div>
        {copyMsg && <p className="muted small" style={{ margin: 0 }}>{copyMsg}</p>}
      </div>

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

function GroupEventRow({ event, onClick, seriesN }: { event: Event; onClick: () => void; seriesN?: number }) {
  return (
    <div
      className={`card ev tile ${event.theme ? `theme-tile theme-${event.theme}` : "type-tile"}`}
      data-testid="group-event"
      style={{ cursor: "pointer" }}
      onClick={onClick}
    >
      {event.photo_url && <EventThumb photo={event.photo_url} size={64} />}
      <div style={{ flex: 1 }}>
        <div className="title">{event.title}</div>
        <div className="muted small">
          {event.status === "polling" ? "Finding a time" : fmtDateTime(event.starts_at)}
          {seriesN && seriesN > 1 ? <span data-testid="series-badge"> · 🔁 {seriesN} dates</span> : null}
        </div>
      </div>
    </div>
  );
}
