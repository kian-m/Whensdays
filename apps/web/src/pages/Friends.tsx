import { useState } from "react";
import {
  AvailabilityDay,
  Commitment,
  Friend,
  FriendRequest,
  commitmentBusy,
  fmtDateTime,
  getJSON,
  nextDays,
  sendJSON,
  useApi,
} from "../lib";
import { AvailLegend, Avatar, ConfirmButton, DayGrid, Loading, useAsync } from "../ui";
import { EVENTS, analytics } from "../analytics";

type Suggestion = { friend_id: string; display_name: string; handle: string; avatar_url: string; score: number; shared_events: number };
type FriendsResp = { friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[]; suggestions: Suggestion[] };

export function Friends() {
  const api = useApi();
  const { data, loading, reload } = useAsync<FriendsResp>((a) => getJSON(a, "/api/friends"));
  const [handle, setHandle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const res = await sendJSON(api, "POST", "/api/friends", { handle });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return setMsg(b.error || "could not add");
    }
    setHandle("");
    setMsg("Request sent ✓");
    reload();
  }

  // Add a suggested person by their handle, then refresh (drops them from the
  // list since a pending request now exists).
  async function addByHandle(h: string) {
    await sendJSON(api, "POST", "/api/friends", { handle: h });
    reload();
  }

  async function accept(id: string) {
    await sendJSON(api, "POST", `/api/friends/${id}/accept`, {});
    reload();
  }

  // Decline an incoming request, cancel an outgoing one, or unfriend - all the
  // same friendship-row delete.
  async function remove(id: string) {
    await api(`/api/friends/${id}`, { method: "DELETE" });
    reload();
  }

  if (loading && !data) return <Loading />;

  return (
    <div className="stack">
      <h1>Friends</h1>

      <form className="card stack" onSubmit={add}>
        <label className="field" htmlFor="h">Add a friend by handle</label>
        <div className="row">
          <input id="h" className="input" data-testid="friend-handle" value={handle}
            onChange={(e) => setHandle(e.target.value)} placeholder="alex" />
          <button className="btn" data-testid="add-friend">Add</button>
        </div>
        {msg && <p className="muted small">{msg}</p>}
      </form>

      {data && data.incoming.length > 0 && (
        <>
          <div className="section-h">Requests</div>
          {data.incoming.map((r) => (
            <div key={r.id} className="card row between">
              <span>{r.display_name} <span className="muted small">@{r.handle}</span></span>
              <span className="row">
                <button className="btn soft sm" data-testid={`accept-${r.handle}`} onClick={() => accept(r.id)}>Accept</button>
                <button className="btn ghost sm" data-testid={`decline-${r.handle}`} onClick={() => remove(r.id)}>Decline</button>
              </span>
            </div>
          ))}
        </>
      )}

      <div className="section-h">Your friends</div>
      {data && data.friends.length === 0 && <p className="muted small">No friends yet - add someone above.</p>}
      {data?.friends.map((f) => <FriendCard key={f.friend_id} friend={f} onRemove={() => remove(f.id)} />)}

      {data && data.suggestions.length > 0 && (
        <>
          <div className="section-h">People you may know</div>
          <p className="muted small" style={{ marginTop: -4 }}>From events you've both been to - the more it was a close, invite-only plan, the higher up.</p>
          {data.suggestions.map((s) => (
            <div key={s.friend_id} className="card row between" data-testid="suggestion">
              <span className="row" style={{ gap: 8 }}>
                <Avatar url={s.avatar_url} name={s.display_name} size={32} />
                <span className="stack" style={{ gap: 0 }}>
                  <span>{s.display_name} <span className="muted small">@{s.handle}</span></span>
                  <span className="muted small">{s.shared_events} event{s.shared_events > 1 ? "s" : ""} together</span>
                </span>
              </span>
              <button className="btn soft sm" data-testid={`suggest-add-${s.handle}`} onClick={() => addByHandle(s.handle)}>Add</button>
            </div>
          ))}
        </>
      )}

      {data && data.outgoing.length > 0 && (
        <>
          <div className="section-h">Pending</div>
          {data.outgoing.map((r) => (
            <div key={r.id} className="card row between">
              <span>{r.display_name} <span className="muted small">@{r.handle}</span></span>
              <span className="row">
                <span className="muted small">Awaiting reply</span>
                <button className="btn ghost sm" data-testid={`cancel-req-${r.handle}`} onClick={() => remove(r.id)}>Cancel</button>
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function FriendCard({ friend, onRemove }: { friend: Friend; onRemove: () => void }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [avail, setAvail] = useState<{ days: AvailabilityDay[]; commitments: Commitment[] } | null>(null);

  async function toggle() {
    if (!open) {
      analytics.capture(EVENTS.friendAvailabilityViewed);
      if (!avail) {
        const res = await api(`/api/friends/${friend.friend_id}/availability`);
        if (res.ok) setAvail(await res.json());
      }
    }
    setOpen((o) => !o);
  }

  const free = new Set((avail?.days ?? []).filter((d) => d.status !== "busy").map((d) => `${d.day}:${d.daypart}`));
  const busy = new Set((avail?.days ?? []).filter((d) => d.status === "busy").map((d) => `${d.day}:${d.daypart}`));
  // Their RSVP'd events overlay the grid as booked - derived from commitments,
  // the same hatched treatment as imported-calendar busy.
  const locked = commitmentBusy(avail?.commitments ?? []);

  return (
    <div className="card stack">
      <div className="row between">
        <span className="row" style={{ gap: 8 }}>
          <Avatar url={friend.avatar_url} name={friend.display_name} size={32} />
          <span>{friend.display_name} <span className="muted small">@{friend.handle}</span></span>
        </span>
        <span className="row">
          <button className="btn ghost sm" data-testid={`view-avail-${friend.handle}`} onClick={toggle}>
            {open ? "Hide" : "Availability"}
          </button>
          <ConfirmButton label="Remove" confirmLabel="Tap again to unfriend" testid={`unfriend-${friend.handle}`}
            onConfirm={onRemove} />
        </span>
      </div>
      {open && avail && (
        <div className="stack">
          <DayGrid dates={nextDays(14)} free={free} busy={busy} locked={locked} readOnly testid="friend-availability" />
          <AvailLegend />
          {avail.commitments.length > 0 && (
            <div className="small">
              <span className="muted">Booked: </span>
              {avail.commitments.map((c) => `${c.title} (${fmtDateTime(c.starts_at)})`).join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
