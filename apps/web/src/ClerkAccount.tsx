import { useState } from "react";
import { useUser, useClerk } from "@clerk/clerk-react";

// Our own account management — replaces Clerk's prebuilt <UserButton>/<UserProfile>.
// Shows the primary email, lets the user change it (Clerk's email-code
// verification), and sign out. Rendered only in Clerk mode (dev has no
// ClerkProvider), so the hooks are always inside a provider.

// Minimal shape of the bits of Clerk's EmailAddressResource we use.
type PendingEmail = {
  id: string;
  prepareVerification: (p: { strategy: "email_code" }) => Promise<unknown>;
  attemptVerification: (p: { code: string }) => Promise<{ id: string }>;
};

export function ClerkAccountCard() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [mode, setMode] = useState<"idle" | "entering" | "verifying">("idle");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<PendingEmail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return null;
  const primary = user.primaryEmailAddress?.emailAddress ?? "—";

  function clerkErr(e: unknown, fallback: string): string {
    const m = e as { errors?: { message?: string }[] };
    return m?.errors?.[0]?.message ?? fallback;
  }

  async function sendCode() {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const ea = (await user!.createEmailAddress({ email })) as unknown as PendingEmail;
      await ea.prepareVerification({ strategy: "email_code" });
      setPending(ea);
      setMode("verifying");
      setMsg(`We sent a 6-digit code to ${email}.`);
    } catch (e) {
      setErr(clerkErr(e, "couldn't send the code"));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!pending) return;
    setErr(null); setBusy(true);
    try {
      const verified = await pending.attemptVerification({ code });
      await user!.update({ primaryEmailAddressId: verified.id });
      await user!.reload();
      setMode("idle"); setEmail(""); setCode(""); setPending(null);
      setMsg("Email updated ✓");
    } catch (e) {
      setErr(clerkErr(e, "invalid code"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="account-card">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Account</h3>
        <button className="btn ghost sm" data-testid="sign-out" onClick={() => signOut()}>Sign out</button>
      </div>
      <div className="muted small">Signed in as <b>{primary}</b></div>

      {mode === "idle" && (
        <button className="btn ghost sm" style={{ alignSelf: "flex-start" }}
          data-testid="change-email-open" onClick={() => { setMode("entering"); setMsg(null); setErr(null); }}>
          Change email
        </button>
      )}
      {mode === "entering" && (
        <div className="row">
          <input className="input" type="email" data-testid="new-email" value={email}
            placeholder="new@email.com" onChange={(e) => setEmail(e.target.value)} />
          <button className="btn sm" data-testid="send-code" disabled={busy || !email.trim()} onClick={sendCode}>
            {busy ? "…" : "Send code"}
          </button>
          <button className="btn ghost sm" onClick={() => { setMode("idle"); setEmail(""); }}>Cancel</button>
        </div>
      )}
      {mode === "verifying" && (
        <div className="row">
          <input className="input" data-testid="email-code" value={code} inputMode="numeric"
            placeholder="6-digit code" onChange={(e) => setCode(e.target.value)} />
          <button className="btn sm" data-testid="verify-code" disabled={busy || !code.trim()} onClick={verify}>
            {busy ? "…" : "Verify"}
          </button>
        </div>
      )}
      {msg && <p className="muted small" data-testid="account-msg">{msg}</p>}
      {err && <p className="err small">{err}</p>}
    </div>
  );
}
