import { useEffect, useState } from "react";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";

// Build-time constant. When "dev", the app runs without Clerk (hermetic
// local/CI runs). Default (prod) uses Clerk. See main.tsx.
export const DEV_AUTH = import.meta.env.VITE_AUTH_MODE === "dev";

type Note = { id: string; body: string; created_at: string };
type Api = (path: string, init?: RequestInit) => Promise<Response>;

export function App() {
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>clSandbox — Notes</h1>
        {!DEV_AUTH && <UserButton />}
      </header>

      {DEV_AUTH ? <Notes api={(p, i) => fetch(p, i)} /> : <ClerkGate />}
    </main>
  );
}

function ClerkGate() {
  return (
    <>
      <SignedOut>
        <p>
          <SignInButton mode="modal">
            <button data-testid="sign-in">Sign in to add notes</button>
          </SignInButton>
        </p>
      </SignedOut>
      <SignedIn>
        <ClerkNotes />
      </SignedIn>
    </>
  );
}

function ClerkNotes() {
  const { getToken } = useAuth();
  // Every request carries the Clerk session token; the API verifies it.
  const api: Api = async (path, init) => {
    const token = await getToken();
    return fetch(path, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });
  };
  return <Notes api={api} />;
}

function Notes({ api }: { api: Api }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await api("/api/notes");
    if (!res.ok) return setError("could not load notes");
    setNotes(await res.json());
  }

  useEffect(() => {
    load().catch(() => setError("could not reach api"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) return setError("could not save note");
    setBody("");
    await load();
  }

  return (
    <>
      <form onSubmit={addNote} style={{ display: "flex", gap: 8 }}>
        <input
          aria-label="note body"
          data-testid="note-input"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a note…"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" data-testid="add-note">Add</button>
      </form>

      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}

      <ul data-testid="note-list" style={{ marginTop: 16, paddingLeft: 18 }}>
        {notes.map((n) => (
          <li key={n.id}>{n.body}</li>
        ))}
      </ul>
    </>
  );
}
