import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Event, Group, GroupDetail, TYPE_COLORS, fmtDateTime, getJSON, sendJSON, useApi } from "../lib";

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
import { Avatar, BackLink, ConfirmButton, GifPicker, Loading, fileToAvatar, useAsync, EventThumb } from "../ui";
import { eventEmoji } from "../scheduler/questions";

// Group icons are an emoji from this palette or an uploaded photo - never free
// text (the API rejects non-emoji values too).
const GROUP_EMOJIS = ["👥", "🎉", "🍜", "📚", "🏃", "🎲", "⛺️", "🍻", "🎬", "🧗", "⚽️", "🎮"];

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
  const [emoji, setEmoji] = useState("👥");
  const [msg, setMsg] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const res = await sendJSON(api, "POST", "/api/groups", { name, emoji });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setMsg(b.error || "could not create");
    }
    setName("");
    setEmoji("👥");
    reload();
  }

  if (loading && !data) return <Loading />;

  return (
    <div className="stack">
      <h1>Groups</h1>

      <form className="card stack" onSubmit={create}>
        <label className="field" htmlFor="gn">Create a group</label>
        <div className="row wrap" style={{ gap: 4 }}>
          {GROUP_EMOJIS.map((em) => (
            <button key={em} type="button" className={`chip sm ${emoji === em ? "on" : ""}`}
              data-testid={`group-emoji-${em}`} onClick={() => setEmoji(em)}>{em}</button>
          ))}
        </div>
        <div className="row">
          <input
            id="gn"
            className="input"
            data-testid="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Crew name"
          />
          <button className="btn" data-testid="group-create">Create</button>
        </div>
        <p className="muted small">Pick an emoji - or upload a photo from the group page after creating.</p>
        {msg && <p className="muted small">{msg}</p>}
      </form>

      <div className="section-h">Your groups</div>
      {data && data.groups.length === 0 && (
        <p className="muted small">No groups yet - make one for your crew.</p>
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

export function GroupPage() {
  const { id } = useParams();
  const api = useApi();
  const nav = useNavigate();
  const { data, loading, reload } = useAsync<GroupDetail>((a) => getJSON(a, `/api/groups/${id}`), [id]);
  const [handle, setHandle] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);
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

  async function removeMember(userId: string) {
    await api(`/api/groups/${id}/members/${userId}`, { method: "DELETE" });
    reload();
  }

  if (loading && !data) return <Loading />;
  if (!data) return <div className="stack"><BackLink /><p className="muted">Group not found.</p></div>;

  const { group, members, events, is_owner } = data;

  return (
    <div className="stack">
      <BackLink />

      <div className="card stack">
        <div className="row between">
          <span className="row" style={{ gap: 10 }}>
            <GroupIcon group={group} size={64} />
            <span className="stack" style={{ gap: 4 }}>
              <h1 data-testid="group-title">{group.name}</h1>
              {groupStreak(events) >= 2 && (
                <span className="pill polling" data-testid="group-streak" style={{ alignSelf: "flex-start" }}>
                  🔥 {groupStreak(events)}-month streak
                </span>
              )}
            </span>
          </span>
          <button
            className="btn sm"
            data-testid="group-new-event"
            onClick={() => nav(`/new?group=${group.id}`)}
          >
            + New event
          </button>
        </div>
        {is_owner && (
          <div className="row wrap">
            <button type="button" className="btn ghost sm" data-testid="group-icon-pick"
              onClick={() => fileRef.current?.click()}>
              {group.icon_url ? "Change photo" : "Use a photo instead"}
            </button>
            <input ref={fileRef} type="file" accept="image/*" data-testid="group-icon-file"
              style={{ display: "none" }} onChange={onPickIcon} />
            <button type="button" className="btn ghost sm" data-testid="group-icon-gif"
              onClick={() => setPickingGif((p) => !p)}>GIF</button>
            <ConfirmButton label="Delete group" confirmLabel="Tap again - events stay, group goes" testid="group-delete"
              onConfirm={async () => { await api(`/api/groups/${id}`, { method: "DELETE" }); nav("/groups"); }} />
          </div>
        )}
        {is_owner && pickingGif && (
          <div style={{ marginTop: 6 }}>
            <GifPicker onPick={async (url) => {
              await sendJSON(api, "PUT", `/api/groups/${id}/icon`, { icon_url: url });
              setPickingGif(false);
              reload();
            }} />
          </div>
        )}
      </div>

      <div className="section-h">Members</div>
      {members.length === 0 && <p className="muted small">No members yet - add someone below.</p>}
      {members.map((m) => (
        <div key={m.user_id} className="card row between" data-testid="group-member">
          <span className="row" style={{ gap: 8 }}>
            <Avatar url={m.avatar_url} name={m.display_name} size={32} />
            <span>
              {m.display_name || m.handle}
              {m.handle && <span className="muted small"> @{m.handle}</span>}
            </span>
          </span>
          {is_owner && (
            <button
              className="btn ghost sm"
              data-testid={`member-remove-${m.handle}`}
              onClick={() => removeMember(m.user_id)}
            >
              Remove
            </button>
          )}
        </div>
      ))}

      {is_owner && (
        <form className="card stack" onSubmit={addMember}>
          <label className="field" htmlFor="mh">Add a member by handle</label>
          <div className="row">
            <input
              id="mh"
              className="input"
              data-testid="member-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="handle"
            />
            <button className="btn" data-testid="member-add">Add</button>
          </div>
          {addMsg && <p className="muted small">{addMsg}</p>}
        </form>
      )}

      {events.length > 0 && (
        <>
          <div className="section-h">Events</div>
          {events.map((e) => (
            <GroupEventRow key={e.id} event={e} onClick={() => nav(`/e/${e.id}`)} />
          ))}
        </>
      )}
    </div>
  );
}

function GroupEventRow({ event, onClick }: { event: Event; onClick: () => void }) {
  return (
    <div
      className={`card ev tile ${event.theme ? `theme-tile theme-${event.theme}` : ""}`}
      data-testid="group-event"
      style={{ cursor: "pointer", borderLeftColor: TYPE_COLORS[event.event_type] ?? TYPE_COLORS.other }}
      onClick={onClick}
    >
      <EventThumb photo={event.photo_url} emoji={eventEmoji(event)} color={TYPE_COLORS[event.event_type] ?? TYPE_COLORS.other} size={event.photo_url ? 64 : 46} />
      <div style={{ flex: 1 }}>
        <div className="title">{event.title}</div>
        <div className="muted small">
          {event.status === "polling" ? "Finding a time" : fmtDateTime(event.starts_at)}
        </div>
      </div>
    </div>
  );
}
