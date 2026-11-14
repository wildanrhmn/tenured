// "Try it on your DAO": replays a DAO's real payout history as if the fast
// lane had been installed, using only what each contributor could have
// claimed at the time. Aggregates only; no per-person output (RULES.md §5).

import { summarize, type Claim, type Rules, type TokenFloor } from "./rules.js";
import type { Payout, Snapshot } from "./types.js";

/// The lane takes at most this many claims per registration.
export const MAX_CLAIMS = 9;

export type SimConfig = {
  dao: string;
  rules: Rules;
  pay_token: string;
  per_account_cap: string;
  period_budget: string;
  period_secs: number;
};

export type PeriodRow = { period_start: string; payouts: number; fast_laned: number; amount: string; budget_used_pct: number };

export type SimResult = {
  dao: string;
  payouts_considered: number;
  fast_laned: number;
  votes_saved: number;
  amount_fast_laned: string;
  not_qualified: number;
  blocked_by_cap: number;
  blocked_by_budget: number;
  max_period_amount: string;
  periods: PeriodRow[];
};

const sec = (p: Payout) => Number(BigInt(p.time_ns) / 1_000_000_000n);

/// Group-role members of each DAO, from the snapshot (current policies).
export type Members = Map<string, Set<string>>;

export function membersOf(daos: { dao: string; groups: Record<string, string[]> }[] | undefined): Members {
  return new Map((daos ?? []).map((d) => [d.dao, new Set(Object.values(d.groups).flat())]));
}

function counts(p: Payout, rules: Rules, members?: Members): boolean {
  if (p.path !== "transfer" || !rules.trusted_daos.includes(p.dao)) return false;
  // Same as the contracts: with no policy on record a member check can only reject.
  if (rules.exclude_members && (!members?.has(p.dao) || members.get(p.dao)!.has(p.receiver))) return false;
  const floor: TokenFloor | undefined = rules.tokens.find((f) => f.token_id === p.token);
  return !!floor && /^[0-9]+$/.test(p.amount) && BigInt(p.amount) >= BigInt(floor.min_amount);
}

/// The best claims an account could present right now: as many distinct
/// DAOs as possible first, then the most recent payouts, at most `MAX_CLAIMS`.
export function discoverClaims(payouts: Payout[], account: string, rules: Rules, before?: number, members?: Members): Claim[] {
  const mine = payouts
    .filter((p) => p.receiver === account && counts(p, rules, members) && (before === undefined || sec(p) < before))
    .sort((a, b) => sec(b) - sec(a));
  const picked: Payout[] = [];
  const daos = new Set<string>();
  for (const p of mine) if (!daos.has(p.dao) && picked.length < MAX_CLAIMS) (daos.add(p.dao), picked.push(p));
  for (const p of mine) if (!picked.includes(p) && picked.length < MAX_CLAIMS) picked.push(p);
  return picked.map((p) => ({ dao_id: p.dao, proposal_id: p.proposal_id }));
}

/// DAOs worth trusting by default: the DAO itself plus the DAOs that paid
/// the same people, ranked by how many contributors they share.
export function suggestTrusted(payouts: Payout[], dao: string, limit = 10): string[] {
  const mine = new Set(payouts.filter((p) => p.dao === dao).map((p) => p.receiver));
  const shared = new Map<string, Set<string>>();
  for (const p of payouts) {
    if (p.dao === dao || !mine.has(p.receiver)) continue;
    (shared.get(p.dao) ?? shared.set(p.dao, new Set()).get(p.dao)!).add(p.receiver);
  }
  const ranked = [...shared.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  return [dao, ...ranked.slice(0, limit - 1).map(([d]) => d)];
}

export function simulate(snap: Pick<Snapshot, "payouts"> & Partial<Pick<Snapshot, "daos">>, cfg: SimConfig): SimResult {
  const members = membersOf(snap.daos);
  const cap = BigInt(cfg.per_account_cap);
  const budget = BigInt(cfg.period_budget);
  const targets = snap.payouts
    .filter((p) => p.dao === cfg.dao && p.path === "transfer" && p.token === cfg.pay_token && /^[0-9]+$/.test(p.amount))
    .sort((a, b) => sec(a) - sec(b) || a.proposal_id - b.proposal_id);

  // Claim discovery only ever looks at one receiver's payouts, so group them
  // once instead of scanning the whole snapshot for every target.
  const byReceiver = new Map<string, Payout[]>();
  for (const p of snap.payouts) (byReceiver.get(p.receiver) ?? byReceiver.set(p.receiver, []).get(p.receiver)!).push(p);

  const usedAccount = new Map<string, bigint>();
  const usedPeriod = new Map<number, bigint>();
  const rows = new Map<number, PeriodRow>();
  const res: SimResult = {
    dao: cfg.dao,
    payouts_considered: targets.length,
    fast_laned: 0,
    votes_saved: 0,
    amount_fast_laned: "0",
    not_qualified: 0,
    blocked_by_cap: 0,
    blocked_by_budget: 0,
    max_period_amount: "0",
    periods: [],
  };
  let total = 0n;

  for (const p of targets) {
    const period = Math.floor(sec(p) / cfg.period_secs);
    const row =
      rows.get(period) ??
      rows
        .set(period, {
          period_start: new Date(period * cfg.period_secs * 1000).toISOString().slice(0, 10),
          payouts: 0,
          fast_laned: 0,
          amount: "0",
          budget_used_pct: 0,
        })
        .get(period)!;
    row.payouts++;

    // Only history from before this payout counts, and the lane reads at
    // most MAX_CLAIMS of it.
    const claims = discoverClaims(byReceiver.get(p.receiver)!, p.receiver, cfg.rules, sec(p), members);
    if (!summarize(claims, cfg.rules).qualifies) {
      res.not_qualified++;
      continue;
    }
    const amount = BigInt(p.amount);
    const key = `${p.receiver}|${period}`;
    const ua = usedAccount.get(key) ?? 0n;
    const up = usedPeriod.get(period) ?? 0n;
    if (ua + amount > cap) {
      res.blocked_by_cap++;
      continue;
    }
    if (up + amount > budget) {
      res.blocked_by_budget++;
      continue;
    }
    usedAccount.set(key, ua + amount);
    usedPeriod.set(period, up + amount);
    total += amount;
    res.fast_laned++;
    res.votes_saved += p.votes;
    row.fast_laned++;
    row.amount = (BigInt(row.amount) + amount).toString();
    row.budget_used_pct = budget > 0n ? Number(((up + amount) * 1000n) / budget) / 10 : 0;
  }

  res.amount_fast_laned = total.toString();
  res.max_period_amount = [...usedPeriod.values()].reduce((m, v) => (v > m ? v : m), 0n).toString();
  res.periods = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  return res;
}
