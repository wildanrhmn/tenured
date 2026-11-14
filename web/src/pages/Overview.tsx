import { Gate, Row } from "../components/ui";
import { Trace, linesFor } from "../components/Trace";
import { fmtInt, fmtPct } from "../lib/format";
import { DEMO } from "../lib/lane";
import { loadReport } from "../lib/report";
import { href } from "../lib/router";
import { useLoad } from "../lib/useSnapshot";

const STEPS = [
  {
    who: "Contributor",
    what: "Files an ordinary Transfer proposal paying themselves, from their own wallet, with the DAO's usual bond.",
    call: "add_proposal",
  },
  {
    who: "Contributor",
    what: "Registers it with the lane, presenting up to nine past payouts from other DAOs as claims, with a 0.01 NEAR storage deposit.",
    call: "register",
  },
  {
    who: "Lane",
    what: "Debits the cap and budget, then reads the proposal and every claimed payout from the DAOs' own records, and their member lists if the DAO excludes members.",
    call: "get_proposal, get_policy",
  },
  {
    who: "Guardians, council",
    what: "Have the veto window to stop it: one guardian alone, or the council's usual reject vote.",
    call: "veto",
    veto: true,
  },
  {
    who: "Anyone",
    what: "Once the window has passed, triggers the lane's single approving vote. The lane never votes on a proposal about to expire.",
    call: "execute",
  },
  {
    who: "DAO treasury",
    what: "Sputnik approves the proposal and pays from the DAO's own funds. The lane never holds money.",
    call: "act_proposal → Transfer",
  },
];

const NEVER = [
  "Votes on a proposal it hasn't registered and checked field by field",
  "Votes on a proposal that is about to expire",
  "Holds funds: every payout is an ordinary approved proposal in the DAO",
  "Keeps a full-access key once it is locked",
  "Changes its own limits; only a DAO proposal can",
];

export function Overview() {
  const report = useLoad(loadReport);
  return (
    <div className="page overview">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">For Sputnik DAOs on NEAR</p>
          <h1>
            Past pay is the proof.
            <br />
            <span className="hero-sub">Read it from the DAOs that paid.</span>
          </h1>
          <div className="lede">
            <p>
              Tenured lets any Sputnik DAO verify what a contributor has already been paid for by other DAOs, reading
              those DAOs' own approved proposals on-chain. There is no oracle, no score and no list of people.
            </p>
            <p>
              A DAO that trusts that history can add a fast lane: a Sputnik role that lets small payouts to proven
              contributors pass after a veto window, paid from the DAO's own treasury.
            </p>
            <p>The council keeps its veto, every request is an ordinary proposal, and the lane never holds funds.</p>
          </div>
          <div className="actions">
            <a className="btn btn-primary" href={href("simulate")}>
              Try it on your DAO
            </a>
            <a className="btn" href={href("check")}>
              Check a record
            </a>
          </div>
        </div>
        <figure className="hero-trace" aria-label="Example verification of one claim">
          <Trace
            animate
            dao={DEMO.alpha}
            id={0}
            account={DEMO.dev}
            read="Approved · Transfer · 0.5 NEAR · not a member"
            lines={linesFor(null, true)}
            verdict={{ ok: true, text: "Valid claim. One of three that qualify this contributor for the fast lane." }}
          />
          <figcaption>A real claim from the testnet demo, checked with the same rules the verifier contract runs.</figcaption>
        </figure>
      </section>

      <section className="section" aria-labelledby="numbers">
        <div className="section-head">
          <h2 id="numbers">What mainnet already holds</h2>
          <p className="muted">Every Sputnik DAO on mainnet, crawled with free view calls.</p>
        </div>
        <Gate load={report} what="Reading the mainnet report">
          {(r) => (
            <div className="ledger-grid">
              <dl className="ledger">
                <Row label="Sputnik DAOs crawled" value={fmtInt(r.daos.total)} note={`${fmtInt(r.daos.with_any_payout)} have paid someone`} />
                <Row label="Payouts read" value={fmtInt(r.payouts.total)} note={`${fmtInt(r.payouts.in_the_last_year)} in the last year`} />
                <Row label="Accounts paid" value={fmtInt(r.receivers.total)} note={`${fmtInt(r.receivers.paid_by_2_or_more_daos)} by two or more DAOs`} />
                <Row
                  tone="accent"
                  label="Could present a record today"
                  value={fmtInt(r.receivers.claimable_from_2_or_more_daos)}
                  note="accounts with valid Transfer claims from two or more DAOs"
                />
                <Row
                  tone="veto"
                  label="DAOs not on published Sputnik code"
                  value={fmtInt((r.daos.by_code_version.custom ?? 0) + r.daos.unreadable)}
                  note={`${fmtInt(r.daos.by_code_version.custom ?? 0)} run custom code, ${fmtInt(r.daos.unreadable)} no longer answer get_proposal; flagged before anyone trusts them`}
                />
              </dl>
              <dl className="ledger">
                <Row
                  label="Payouts filed by their receiver"
                  value={fmtPct(r.payouts.filed_by_the_receiver_pct)}
                  note="contributors already propose their own pay; the lane keeps that habit"
                />
                <Row
                  label="Paid to members of the paying DAO"
                  value={fmtPct(r.payouts.to_members_of_the_paying_dao_pct)}
                  note="a DAO can choose not to count these (rule 9)"
                />
                <Row
                  label="Missed by a Transfer-only crawl"
                  value={fmtPct(r.payouts.missed_by_a_transfer_only_crawl_pct)}
                  note="bounties, token transfers and Intents payouts, read off-chain"
                />
                <Row
                  label="Opaque chain-signature payouts"
                  value={fmtInt(r.payouts.opaque.chain_signature)}
                  note={`approved, but the receiver can't be read from the proposal. Snapshot of ${r.snapshot.factory}, ${r.snapshot.crawled_to.slice(0, 10)}`}
                />
              </dl>
            </div>
          )}
        </Gate>
      </section>

      <section className="section" aria-labelledby="how">
        <div className="section-head">
          <h2 id="how">How a fast-lane payout happens</h2>
          <p className="muted">Six steps, all on-chain. Money moves once, at the end, from the DAO.</p>
        </div>
        <ol className="flow">
          {STEPS.map((s, i) => (
            <li key={s.call} className={s.veto ? "flow-step is-veto" : "flow-step"}>
              <span className="flow-n">{i + 1}</span>
              <p className="flow-who">{s.who}</p>
              <p className="flow-what">{s.what}</p>
              <code className="flow-call">{s.call}</code>
            </li>
          ))}
        </ol>
      </section>

      <section className="section split" aria-labelledby="never">
        <div>
          <h2 id="never">What the lane never does</h2>
          <p className="muted">
            It is a Sputnik role member with one permission, <code>transfer:VoteApprove</code>. If every check failed at
            once, the most it could move is one period's budget, in plain sight, and one proposal removes it.
          </p>
        </div>
        <ul className="never">
          {NEVER.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
