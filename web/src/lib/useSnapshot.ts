import { useEffect, useState } from "react";
import { loadSnapshot, type SnapshotIndex } from "./snapshot";

export type Loadable<T> = { status: "loading" } | { status: "error"; error: string; retry: () => void } | { status: "ready"; value: T };

export function useLoad<T>(load: () => Promise<T>): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    load().then(
      (value) => live && setState({ status: "ready", value }),
      (e: Error) => live && setState({ status: "error", error: e.message, retry: () => setAttempt((a) => a + 1) }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return state;
}

export const useSnapshot = (): Loadable<SnapshotIndex> => useLoad(loadSnapshot);
