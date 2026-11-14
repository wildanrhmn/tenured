import { useEffect, useState } from "react";
import { ROUTES, href, useRoute } from "./lib/router";
import { Overview } from "./pages/Overview";
import { Simulate } from "./pages/Simulate";
import { Check } from "./pages/Check";
import { Live } from "./pages/Live";
import { Install } from "./pages/Install";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : "system";
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("tenured-theme");
      else localStorage.setItem("tenured-theme", theme);
    } catch {
      /* storage can be blocked; the choice just won't persist */
    }
  }, [theme]);
  return [theme, setTheme];
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="18" width="4" height="10" rx="1.2" />
      <rect x="11" y="13" width="4" height="15" rx="1.2" />
      <rect x="18" y="8" width="4" height="20" rx="1.2" />
      <rect className="mark-last" x="25" y="4" width="4" height="24" rx="1.2" />
    </svg>
  );
}

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <a className="brand" href={href("overview")}>
            <Mark />
            <span>Tenured</span>
          </a>
          <button
            type="button"
            className="theme"
            onClick={() => setTheme(next[theme])}
            aria-label={`Colour theme: ${theme}. Switch to ${next[theme]}.`}
            title={`Theme: ${theme}`}
          >
            <span aria-hidden="true" className={`theme-dot theme-${theme}`} />
            <span className="theme-label">{theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}</span>
          </button>
        </div>
        <nav className="tabs" aria-label="Sections">
          <div className="tabs-inner">
            {ROUTES.map((r) => (
              <a key={r.id} href={href(r.id)} aria-current={route.id === r.id ? "page" : undefined}>
                {r.label}
              </a>
            ))}
          </div>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {route.id === "overview" && <Overview />}
        {route.id === "simulate" && <Simulate initialDao={route.param} />}
        {route.id === "check" && <Check initialAccount={route.param} />}
        {route.id === "live" && <Live />}
        {route.id === "install" && <Install />}
      </main>
      <footer className="foot">
        <p>
          Tenured reads Sputnik DAO proposals on NEAR. Off-chain numbers come from a snapshot of mainnet and are never
          used for money: the contracts re-read every claim on-chain.
        </p>
        <p>MIT licensed. Built for the NEAR hackathon, November 2026.</p>
      </footer>
    </>
  );
}
