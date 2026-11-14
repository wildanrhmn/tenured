import { useEffect, useRef, useState } from "react";
import { Wordmark } from "./components/Brand";
import { ROUTES, href, useRoute } from "./lib/router";
import { Overview } from "./pages/Overview";
import { Simulate } from "./pages/Simulate";
import { Check } from "./pages/Check";
import { Live } from "./pages/Live";
import { Install } from "./pages/Install";

export const REPO = "https://github.com/wildanrhmn/tenured";

/** Floating capsule nav: logo left, links in the middle, one action right; a sheet on phones. */
function Nav({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  const burger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("menu-open", open);
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        burger.current?.focus();
      }
    };
    const wide = matchMedia("(min-width: 961px)");
    const onWide = () => wide.matches && setOpen(false);
    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);

  useEffect(() => setOpen(false), [current]);

  return (
    <>
      <header className={open ? "nav open" : "nav"}>
        <div className="nav-in">
          <a className="brand" href={href("overview")} aria-label="Tenured, overview">
            <Wordmark />
          </a>
          <nav className="nav-links" id="nav-menu" aria-label="Primary">
            {ROUTES.map((r) => (
              <a key={r.id} href={href(r.id)} aria-current={current === r.id ? "page" : undefined} onClick={() => setOpen(false)}>
                {r.label}
              </a>
            ))}
            <a className="ext" href={REPO} target="_blank" rel="noreferrer">
              Docs
            </a>
            <a className="nav-cta-menu" href={href("simulate")} onClick={() => setOpen(false)}>
              Try it on your DAO
            </a>
          </nav>
          <div className="nav-end">
            <a className="nav-cta" href={href("simulate")} aria-current={current === "simulate" ? "page" : undefined}>
              Try it on your DAO{" "}
              <span className="arrow" aria-hidden="true">
                →
              </span>
            </a>
            <button
              ref={burger}
              className="burger"
              type="button"
              aria-expanded={open}
              aria-controls="nav-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
            >
              <span />
              <span />
            </button>
          </div>
        </div>
      </header>
      <div className="nav-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
    </>
  );
}

/** The last call to action points at the simulator, or at your own record from inside it. */
function Footer({ current }: { current: string }) {
  const onSim = current === "simulate";
  return (
    <footer className="foot">
      <div className="foot-inner">
        <div className="foot-cta">
          {onSim ? (
            <h2>
              Been paid by DAOs before?
              <span>Check what your record is worth.</span>
            </h2>
          ) : (
            <h2>
              Replay your DAO's own history.
              <span>It runs in your browser, in seconds.</span>
            </h2>
          )}
          <a className="pill pill-bolt" href={href(onSim ? "check" : "simulate")}>
            {onSim ? "Check a record" : "Try it on your DAO"}{" "}
            <span className="arrow" aria-hidden="true">
              →
            </span>
          </a>
        </div>
        <div className="foot-cols">
          <div className="foot-brand">
            <a className="brand" href={href("overview")} aria-label="Tenured, overview">
              <Wordmark />
            </a>
            <p>Your DAO track record, verified on-chain. Proven contributors skip the queue.</p>
          </div>
          <nav className="foot-nav" aria-label="Footer">
            <div>
              <p>Product</p>
              <a href={href("simulate")}>Simulator</a>
              <a href={href("check")}>Check a record</a>
              <a href={href("live")}>Live lane</a>
              <a href={href("install")}>Install</a>
            </div>
            <div>
              <p>Source</p>
              <a href={REPO} target="_blank" rel="noreferrer">
                GitHub
              </a>
              <a href={`${REPO}/blob/main/RULES.md`} target="_blank" rel="noreferrer">
                Rules
              </a>
              <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
                MIT license
              </a>
            </div>
            <div>
              <p>Built on</p>
              <a href="https://near.org" target="_blank" rel="noreferrer">
                NEAR
              </a>
              <a href="https://github.com/near-daos/sputnik-dao-contract" target="_blank" rel="noreferrer">
                Sputnik DAO
              </a>
            </div>
          </nav>
        </div>
        <div className="foot-base">
          <span>Built for the NEAR hackathon, November 2026</span>
          <span className="mono">snapshot is never used for money · contracts re-read every claim</span>
        </div>
      </div>
      <div className="foot-mark" aria-hidden="true">
        <span>Tenured</span>
      </div>
    </footer>
  );
}

export function App() {
  const route = useRoute();
  return (
    <>
      {/* Hash routing owns the URL fragment, so the skip link moves focus itself. */}
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <Nav current={route.id} />
      <main id="main" tabIndex={-1}>
        {route.id === "overview" && <Overview />}
        {route.id === "simulate" && <Simulate initialDao={route.param} />}
        {route.id === "check" && <Check initialAccount={route.param} />}
        {route.id === "live" && <Live />}
        {route.id === "install" && <Install />}
      </main>
      <Footer current={route.id} />
    </>
  );
}
