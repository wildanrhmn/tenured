import { useEffect, useState } from "react";

// Hash routes, so the app works from any static host and sub-path.
export const ROUTES = [
  { id: "overview", label: "Overview" },
  { id: "simulate", label: "Simulator" },
  { id: "check", label: "Check a record" },
  { id: "live", label: "Live lane" },
  { id: "install", label: "Install" },
] as const;

export type RouteId = (typeof ROUTES)[number]["id"];

export type Route = { id: RouteId; param: string };

export function parseHash(hash: string): Route {
  const [id = "", ...rest] = hash.replace(/^#\/?/, "").split("/");
  const known = ROUTES.find((r) => r.id === id);
  return { id: known ? known.id : "overview", param: decodeURIComponent(rest.join("/")) };
}

export const href = (id: RouteId, param?: string) => `#/${id}${param ? `/${encodeURIComponent(param)}` : ""}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      const next = parseHash(window.location.hash);
      setRoute((prev) => {
        if (prev.id !== next.id) window.scrollTo(0, 0);
        return next;
      });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
