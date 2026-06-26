import { useState } from "react";
import {
  AvailabilitySlot,
  Commitment,
  Friend,
  FriendRequest,
  WEEKDAYS,
  fmtDateTime,
  getJSON,
  sendJSON,
  useApi,
} from "../lib";
import { Loading, useAsync } from "../ui";
import { EVENTS, analytics } from "../analytics";

type FriendsResp = { friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[] };

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

  async function accept(id: string) {
    await sendJSON(api, "POST", `/api/friends/${id}/accept`, {});
    reload();
  }

  if (loading) return <Loading />;

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
              <button className="btn soft sm" data-testid={`accept-${r.handle}`} onClick={() => accept(r.id)}>Accept</button>
            </div>
          ))}
        </>
      )}

      <div className="section-h">Your friends</div>
      {data && data.friends.length === 0 && <p className="muted small">No friends yet — add someone above.</p>}
      {data?.friends.map((f) => <FriendCard key={f.friend_id} friend={f} />)}

      {data && data.outgoing.length > 0 && (
        <>
          <div className="section-h">Pending</div>
          {data.outgoing.map((r) => (
            <div key={r.id} className="card row between">
              <span>{r.display_name} <span className="muted small">@{r.handle}</span></span>
              <span className="muted small">Awaiting reply</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function FriendCard({ friend }: { friend: Friend }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [avail, setAvail] = useState<{ slots: AvailabilitySlot[]; commitments: Commitment[] } | null>(null);

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

  const free = new Set((avail?.slots ?? []).map((s) => `${s.weekday}-${s.part_of_day}`));

  return (
    <div className="card stack">
      <div className="row between">
        <span>{friend.display_name} <span className="muted small">@{friend.handle}</span></span>
        <button className="btn ghost sm" data-testid={`view-avail-${friend.handle}`} onClick={toggle}>
          {open ? "Hide" : "Availability"}
        </button>
      </div>
      {open && avail && (
        <div className="stack">
          <div className="grid">
            <div />
            {["morning", "afternoon", "evening"].map((p) => <div key={p} className="hd">{p}</div>)}
            {WEEKDAYS.map((d, wd) => (
              <Row key={wd} day={d} wd={wd} free={free} />
            ))}
          </div>
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

function Row({ day, wd, free }: { day: string; wd: number; free: Set<string> }) {
  return (
    <>
      <div className="day">{day}</div>
      {["morning", "afternoon", "evening"].map((p) => (
        <div key={p} className={`cell ${free.has(`${wd}-${p}`) ? "on" : ""}`} />
      ))}
    </>
  );
}
