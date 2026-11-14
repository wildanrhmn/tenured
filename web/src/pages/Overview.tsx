import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { fmtInt, fmtPct } from "../lib/format";
import { DEMO } from "../lib/lane";
import { loadReport, type Report } from "../lib/report";
import { href } from "../lib/router";
import { useLoad } from "../lib/useSnapshot";
import { useReveal } from "../lib/useReveal";

const EXAMPLE_DAO = "nearweek-news-contribution.sputnik-dao.near";

const Tick = () => (
  <span className="tick" aria-hidden="true">
    <svg viewBox="0 0 16 16">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  </span>
);

type Step = { title: string; body: ReactNode; screen: ReactNode; veto?: boolean };

const STEPS: Step[] = [
  {
    title: "The contributor files their own payout",
    body: (
      <>
        An ordinary <code>Transfer</code> proposal in the DAO, paying themselves, from their own wallet with the DAO's usual bond.
        Most mainnet payouts are already filed this way.
      </>
    ),
    screen: (
      <>
        <p className="cap">
          <code>add_proposal</code> in the funding DAO
        </p>
        <dl className="kv">
          <div>
            <dt>Proposal</dt>
            <dd>#17</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>Transfer · 0.1 NEAR</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{DEMO.dev}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>InProgress</dd>
          </div>
        </dl>
      </>
    ),
  },
  {
    title: "…and registers it with the lane",
    body: (
      <>
        Presenting up to nine past payouts from other DAOs as claims, with a 0.01 NEAR deposit for the request's storage. Nothing
        about an account is published unless its owner presents it.
      </>
    ),
    screen: (
      <>
        <p className="big-num">
          <b>3</b>
          <em>claims from 2 DAOs</em>
        </p>
        <ul className="tick-list">
          {["trackrecord-alpha#0", "trackrecord-alpha#1", "trackrecord-beta#0"].map((c) => (
            <li key={c}>
              <Tick />
              <span>{c}</span>
            </li>
          ))}
        </ul>
        <p className="cap">
          <code>register(proposal_id, amount, claims, nonce)</code> + 0.01 NEAR
        </p>
      </>
    ),
  },
  {
    title: "The lane reads every DAO itself",
    body: (
      <>
        It debits the cap and the budget first, then reads the proposal and each claimed payout from the paying DAOs' own records
        with <code>get_proposal</code>, plus their member lists if the DAO excludes members. No oracle, no index.
      </>
    ),
    screen: (
      <ul className="tick-list">
        {[
          "#17 is theirs, to them, exact amount",
          "alpha#0 Approved, paid to them",
          "alpha#1 Approved, paid to them",
          "beta#0 Approved, paid to them",
          "2 DAOs · 3 payouts: qualifies",
        ].map((c) => (
          <li key={c}>
            <Tick />
            <span>{c}</span>
          </li>
        ))}
      </ul>
    ),
  },
  {
    title: "The veto window",
    veto: true,
    body: (
      <>
        Any single guardian can stop the request alone, and the council can still reject it the usual way in Sputnik or Trezu. A
        stopped request gives the cap and budget back.
      </>
    ),
    screen: (
      <>
        <p className="big-num">
          <b>10m</b>
          <em>left to veto</em>
        </p>
        <div className="window" aria-hidden="true">
          <i />
        </div>
        <p className="window-legend">
          <span>registered</span>
          <span>executable</span>
        </p>
        <p className="cap">
          <code>veto(id)</code> by any guardian
        </p>
      </>
    ),
  },
  {
    title: "Anyone triggers the vote",
    body: (
      <>
        After the window, <code>execute</code> can be called by anyone. The lane checks the request is still waiting and the
        proposal won't expire in the next five minutes, then casts its single vote.
      </>
    ),
    screen: (
      <>
        <span className="vote-pill">VoteApprove · fastlane 1/1</span>
        <p className="cap">
          The lane's only permission is <code>transfer:VoteApprove</code>, and it only uses it on a request it registered and
          checked.
        </p>
      </>
    ),
  },
  {
    title: "The DAO's own treasury pays",
    body: (
      <>
        Sputnik approves the proposal and pays from the DAO's treasury, like any approved transfer. The lane then reads the result
        back instead of assuming it.
      </>
    ),
    screen: (
      <>
        <p className="big-num">
          <b>0.1</b>
          <em>NEAR · Approved</em>
        </p>
        <p className="cap">Paid by the DAO. The lane never held it, and never will.</p>
      </>
    ),
  },
];

type Who = { name: string; note: string; v: ("0" | "1" | "w")[]; us?: boolean };
const POWERS = ["File proposals", "Vote approve", "Veto in the window", "Trigger the vote", "Change the config", "Hold money"];
const WHO: Who[] = [
  { name: "The lane", note: "a role with one permission", v: ["0", "w", "0", "0", "0", "0"], us: true },
  { name: "The contributor", note: "for their own payout", v: ["1", "0", "0", "1", "0", "0"] },
  { name: "Any one guardian", note: "listed in the config", v: ["0", "0", "1", "1", "0", "0"] },
  { name: "The council", note: "through ordinary proposals", v: ["1", "1", "1", "1", "1", "0"] },
  { name: "Anyone else", note: "no account needed", v: ["0", "0", "0", "1", "0", "0"] },
  { name: "The DAO treasury", note: "Sputnik pays from it", v: ["0", "0", "0", "0", "0", "1"] },
];
const LABEL: Record<Who["v"][number], string> = { "1": "can", "0": "can't", w: "only checked requests" };

type Receipt = { what: string; big: ReactNode; tone?: "ok" | "no"; rows: [string, string][]; tx: string };
const TXS: Receipt[] = [
  {
    what: "The verifier attests a record",
    big: (
      <>
        3 <small>payouts · 2 DAOs</small>
      </>
    ),
    rows: [
      ["Call", "verify"],
      ["Members", "excluded"],
      ["Event", "verified + rules_hash"],
    ],
    tx: "ECzBrwtb3SSPxPdkqBeAQ6chBzTYx3pK6UoakLJ1uA1f",
  },
  {
    what: "The contributor registers a request",
    big: (
      <>
        0.1 <small>NEAR</small>
      </>
    ),
    rows: [
      ["Call", "register"],
      ["Deposit", "0.01 NEAR"],
    ],
    tx: "8wNfnRUMj3VDcBZu9NhQufjPT1Up8ASZv4o34U6ggrQ9",
  },
  {
    what: "Execute before the window closes",
    big: "Refused",
    tone: "no",
    rows: [
      ["Call", "execute"],
      ["Why", "veto window still open"],
    ],
    tx: "2dZ2cbTz8N4qeZs2PknwLVerZFtHdyXgBGyrQMj4fDLD",
  },
  {
    what: "After the window: the lane votes, the DAO pays",
    big: "Paid",
    tone: "ok",
    rows: [
      ["Call", "execute"],
      ["DAO status", "Approved"],
    ],
    tx: "kMA2pTPf5izkTdn4Ax4cLqT5hatPohkEzVo8mKLajvb",
  },
  {
    what: "A guardian vetoes on their own",
    big: "Vetoed",
    tone: "no",
    rows: [
      ["Call", "veto"],
      ["Limits", "credited back"],
    ],
    tx: "GFqgveXFyJzhdMcEVYQjXsJLEPgqrL9PanjBLwuMWgDk",
  },
  {
    what: "Someone presents another account's payouts",
    big: "Refused",
    tone: "no",
    rows: [
      ["Call", "register"],
      ["Why", "track record too short"],
    ],
    tx: "QyYsnaj51SaPct2YDqNtZQjMC1Q4TjJnBqe4VXevE3m",
  },
  {
    what: "The DAO changes the lane's config",
    big: "Configured",
    tone: "ok",
    rows: [
      ["Through", "a DAO proposal"],
      ["Call", "configure"],
    ],
    tx: "kfgHt7RJekFWVUkJwuJZQ1YwX9tQSjEbLEqr2cqAc8c",
  },
  {
    what: "Anyone else calls configure",
    big: "Refused",
    tone: "no",
    rows: [
      ["Call", "configure"],
      ["Why", "only the DAO can"],
    ],
    tx: "soSzfHYVAqzeVzGPr9jABhKhZZa7dYQHpJnrekpVkfX",
  },
  {
    what: "A registration without the deposit",
    big: "Refused",
    tone: "no",
    rows: [
      ["Call", "register"],
      ["Why", "no storage deposit"],
    ],
    tx: "4oHmVpfCRXTtA9bBJaPZrXQz7z8AmaMkQhcSh22oSbqh",
  },
];

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

function Stats({ r }: { r: Report | null }) {
  const items: [string, (r: Report) => string][] = [
    ["Sputnik DAOs crawled", (r) => fmtInt(r.daos.total)],
    ["Payouts read from proposals", (r) => fmtInt(r.payouts.total)],
    ["Accounts that could present a record today", (r) => fmtInt(r.receivers.claimable_from_2_or_more_daos)],
    ["Payouts that went to the paying DAO's own members", (r) => fmtPct(r.payouts.to_members_of_the_paying_dao_pct)],
  ];
  return (
    <dl className={r ? "stats" : "stats stats-skel"} aria-busy={!r}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{r ? value(r) : "0,000"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Overview() {
  const report = useLoad(loadReport);
  const root = useRef<HTMLDivElement>(null);
  const [dao, setDao] = useState(EXAMPLE_DAO);
  useReveal(root);
  const r = report.status === "ready" ? report.value : null;
  const go = () => {
    window.location.hash = href("simulate", dao.trim().toLowerCase() || EXAMPLE_DAO);
  };
  const delay = (i: number): CSSProperties => ({ transitionDelay: `${i * 90}ms` });

  return (
    <div className="landing" ref={root}>
      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow" data-reveal style={delay(0)}>
          For Sputnik DAOs on NEAR
        </p>
        <h1 id="hero-title">
          <span className="h-line" data-reveal style={delay(1)}>
            Your DAO track record,
          </span>
          <span className="h-line h-dim" data-reveal style={delay(2)}>
            verified on-chain.
          </span>
        </h1>
        <p className="hero-sub" data-reveal style={delay(3)}>
          Proven contributors skip the queue. A new DAO reads what other DAOs already paid someone, straight from their own
          proposals, and lets small payouts through after a veto window.
        </p>

        <form
          className="quick"
          data-reveal
          style={delay(4)}
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
          aria-label="Simulate a DAO"
        >
          <label className="leg" htmlFor="quick-dao">
            <span className="leg-label">Replay a DAO's history</span>
            <span className="leg-row">
              <input
                id="quick-dao"
                className="leg-amount leg-input small"
                value={dao}
                onChange={(e) => setDao(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
            </span>
            <span className="leg-foot">Any of the 711 mainnet DAOs that ever paid someone</span>
          </label>
          <div className="leg">
            <span className="leg-label">Would have skipped a council vote</span>
            <span className="leg-row">
              <span className="leg-amount">1,645</span>
              <span className="chip-tok">of 4,907</span>
            </span>
            <span className="leg-foot">NEARWEEK's NEAR payouts, 500 cap, 2,000 budget a month</span>
          </div>
          <button type="submit" className="pill pill-bolt pill-block">
            Simulate this DAO{" "}
            <span className="arrow" aria-hidden="true">
              →
            </span>
          </button>
        </form>
        <a className="quick-note" href={href("check")} data-reveal style={delay(5)}>
          Or check your own record against mainnet →
        </a>

        <Stats r={r} />
      </section>

      <section className="sec" aria-labelledby="how">
        <div className="sec-head" data-reveal>
          <h2 id="how">
            How a fast-lane payout happens. <span>All on-chain.</span>
          </h2>
          <p className="sec-sub">Six steps. Money moves once, at the end, from the DAO's own treasury.</p>
        </div>
        <ol className="hiw-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className={s.veto ? "hstep is-veto" : "hstep"}>
              <div className="hstep-text" data-reveal>
                <p className="step-n">{String(i + 1).padStart(2, "0")}</p>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
              <div className="screen" data-reveal style={delay(1)} aria-hidden="true">
                {s.screen}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="sec" aria-labelledby="trust">
        <div className="sec-head" data-reveal>
          <h2 id="trust">
            Who can do what. <span>The lane can do very little.</span>
          </h2>
          <p className="sec-sub">
            The lane is a Sputnik role member, never a treasury. Its worst case is one period's budget, in plain sight, and one
            proposal removes it.
          </p>
        </div>
        <div className="grid-wrap" data-reveal>
          <div className="sees" role="table" aria-label="Who can do what">
            <div className="sees-row sees-head" role="row">
              <span role="columnheader">
                <span className="sr-only">Who</span>
              </span>
              {POWERS.map((p) => (
                <span key={p} role="columnheader">
                  {p}
                </span>
              ))}
            </div>
            {WHO.map((w) => (
              <div key={w.name} className={w.us ? "sees-row is-us" : "sees-row"} role="row">
                <span role="rowheader">
                  {w.name}
                  <small>{w.note}</small>
                </span>
                {w.v.map((v, i) => (
                  <i key={POWERS[i]} data-v={v} data-label={POWERS[i]} role="cell" aria-label={`${POWERS[i]}: ${LABEL[v]}`} />
                ))}
              </div>
            ))}
          </div>
          <p className="grid-note">
            <span>
              <i data-v="1" aria-hidden="true" /> can
            </span>
            <span>
              <i data-v="w" aria-hidden="true" /> only on a request it registered and checked, after the window
            </span>
          </p>
        </div>
        <p className="promises" data-reveal>
          <span>One permission: transfer:VoteApprove</span>
          <i aria-hidden="true" />
          <span>Never votes near a proposal's expiry</span>
          <i aria-hidden="true" />
          <span>No full-access key once locked</span>
        </p>
      </section>

      <section className="sec" aria-labelledby="proof">
        <div className="sec-head" data-reveal>
          <h2 id="proof">
            Nine transactions on testnet. <span>Receipts included.</span>
          </h2>
          <p className="sec-sub">
            The demo run against the current contracts: the happy path, and every way it refuses. Each one opens on nearblocks.
          </p>
        </div>
        {[0, 3, 6].map((from) => (
          <div className="rail" data-reveal key={from}>
            <div className="slot" aria-hidden="true" />
            <ol className="receipts" start={from + 1}>
              {TXS.slice(from, from + 3).map((t, j) => {
                const i = from + j;
                return (
                  <li key={t.tx} className="r-hang">
                    <article className="rcpt" aria-label={t.what}>
                      <p className="r-top">
                        <span>No. {String(i + 1).padStart(2, "0")}</span>
                        <span>testnet</span>
                      </p>
                      <p className="r-dir">{t.what}</p>
                      <p className={`r-big${t.tone ? ` ${t.tone}` : ""}`}>{t.big}</p>
                      <dl className="r-rows">
                        {t.rows.map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                        <div>
                          <dt>Transaction</dt>
                          <dd>
                            <a href={`https://testnet.nearblocks.io/txns/${t.tx}`} target="_blank" rel="noreferrer">
                              {short(t.tx)} ↗
                            </a>
                          </dd>
                        </div>
                      </dl>
                    </article>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
        <p className="proof-note">
          Testnet accounts keep the project's working name, trackrecord-*. Watch the lane read live on the{" "}
          <a href={href("live")}>Live lane</a> page.
        </p>
      </section>
    </div>
  );
}
