import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiFn, useApi } from "./lib";

// Small data-loading hook: runs `fn` on mount and exposes a reload().
export function useAsync<T>(fn: (api: ApiFn) => Promise<T>, deps: unknown[] = []) {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setLoading(true);
    fn(api)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(run, [run]);
  return { data, loading, error, reload: run };
}

export function Loading() {
  return <p className="muted" style={{ marginTop: "2rem" }}>Loading…</p>;
}

export function BackLink() {
  return (
    <Link to="/" className="muted small" style={{ display: "inline-block", marginBottom: "0.6rem" }}>
      ← All events
    </Link>
  );
}

export function Pill({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}
