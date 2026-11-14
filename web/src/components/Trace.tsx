import type { ReactNode } from "react";
import type { Reject } from "../engine";
import { Pointer } from "./ui";

export type TraceLine = { n: number; text: ReactNode; state: "ok" | "no" | "skip" | "pending" };

const MARK: Record<TraceLine["state"], string> = { ok: "pass", no: "fail", skip: "not read", pending: "reading" };

/**
 * The verification trace: one claim pointer, then each numbered rule from
 * RULES.md §1 and whether it held.
 */
export function Trace({
  dao,
  id,
  account,
  read,
  lines,
  verdict,
  animate,
}: {
  dao: string;
  id: number;
  account: string;
  read?: ReactNode;
  lines: TraceLine[];
  verdict: { ok: boolean; text: ReactNode } | null;
  animate?: boolean;
}) {
  return (
    <div className={`trace${animate ? " trace-animate" : ""}`}>
      <dl className="trace-head">
        <div>
          <dt>claim</dt>
          <dd>
            <Pointer dao={dao} id={id} />
          </dd>
        </div>
        <div>
          <dt>presented by</dt>
          <dd className="acct">{account}</dd>
        </div>
        {read && (
          <div>
            <dt>read live</dt>
            <dd>{read}</dd>
          </div>
        )}
      </dl>
      <ol className="trace-lines">
        {lines.map((l, i) => (
          <li key={l.n} className={`t-${l.state}`} style={animate ? { animationDelay: `${180 + i * 90}ms` } : undefined}>
            <span className="t-mark" aria-label={MARK[l.state]}>
              {l.state === "ok" ? (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              ) : l.state === "no" ? (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                </svg>
              ) : (
                <span className="t-dash" aria-hidden="true" />
              )}
            </span>
            <span className="t-n">{l.n}</span>
            <span className="t-text">{l.text}</span>
          </li>
        ))}
      </ol>
      {verdict && (
        <p
          className={`trace-verdict ${verdict.ok ? "is-ok" : "is-no"}`}
          style={animate ? { animationDelay: `${180 + lines.length * 90 + 120}ms` } : undefined}
        >
          {verdict.text}
        </p>
      )}
    </div>
  );
}

/** The claim rules, in RULES.md order. Rule 9 only applies when the funding DAO excludes members. */
export const RULE_TEXT = [
  "DAO was created by the Sputnik factory",
  "DAO is on the funding DAO's trusted list",
  "Proposal status is Approved",
  "Proposal kind is Transfer, with no msg",
  "Receiver is the account presenting it",
  "Paid in a token the funding DAO counts",
  "Amount is at least that token's floor",
  "Not presented twice in this request",
  "Receiver isn't a member of the paying DAO",
] as const;

/** Which rule number a rejection reason breaks. */
export const REJECT_RULE: Record<Reject, number> = {
  NotFactoryDao: 1,
  NotTrusted: 2,
  Duplicate: 8,
  NotFound: 3,
  Unreadable: 3,
  NotApproved: 3,
  NotTransfer: 4,
  WithMsg: 4,
  WrongReceiver: 5,
  TokenNotCounted: 6,
  BelowFloor: 7,
  DaoMember: 9,
};

export const REJECT_TEXT: Record<Reject, string> = {
  NotFactoryDao: "Not a DAO created by the Sputnik factory",
  NotTrusted: "Not on the trusted list",
  Duplicate: "Presented twice",
  NotFound: "No such proposal in that DAO",
  Unreadable: "The DAO returned a proposal that couldn't be read",
  NotApproved: "Not approved by the DAO",
  NotTransfer: "Not a Transfer proposal",
  WithMsg: "A transfer with a msg, which the receiver could hand back",
  WrongReceiver: "Pays a different account",
  TokenNotCounted: "Paid in a token that isn't counted",
  BelowFloor: "Below the floor for its token",
  DaoMember: "Paid to a member of the paying DAO",
};

// The order the contracts check in: 1, 2 and 8 before the proposal is
// read, then 3 to 7 on the proposal, then 9 on the DAO's policy.
const ORDER = [1, 2, 8, 3, 4, 5, 6, 7, 9];

/** Builds trace lines for a claim from its rejection reason (null = valid, undefined = not read yet). */
export function linesFor(reason: Reject | null | undefined, excludeMembers: boolean): TraceLine[] {
  const broken = reason ? ORDER.indexOf(REJECT_RULE[reason]) : ORDER.length;
  return RULE_TEXT.map((text, i) => {
    const n = i + 1;
    if (n === 9 && !excludeMembers) return { n, text: `${text} (not required here)`, state: "skip" };
    const at = ORDER.indexOf(n);
    const state: TraceLine["state"] = reason === undefined ? "pending" : at < broken ? "ok" : at === broken ? "no" : "skip";
    return { n, text, state };
  });
}
