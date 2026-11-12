import { describe, expect, it } from "vitest";
import type { Payout } from "../src/payouts.js";
import { discoverClaims, simulate, suggestTrusted, type SimConfig } from "../src/simulate.js";

const DAY = 86_400;
const t = (day: number) => (BigInt(day * DAY) * 1_000_000_000n).toString();
const pay = (dao: string, id: number, receiver: string, amount: number, day: number, votes = 2): Payout => ({
  dao,
  proposal_id: id,
  path: "transfer",
  receiver,
  token: "",
  amount: String(amount),
  time_ns: t(day),
  proposer: receiver,
  votes,
});

const A = "a.sputnik-dao.near";
const B = "b.sputnik-dao.near";
const FUND = "fund.sputnik-dao.near";

const cfg = (over: Partial<SimConfig> = {}): SimConfig => ({
  dao: FUND,
  rules: {
    trusted_daos: [A, B, FUND],
    tokens: [{ token_id: "", min_amount: "10" }],
    min_distinct_daos: 2,
    min_payouts: 2,
  },
  pay_token: "",
  per_account_cap: "100",
  period_budget: "150",
  period_secs: 30 * DAY,
  ...over,
});

describe("simulate", () => {
  it("only counts history from before each payout", () => {
    const payouts = [
      pay(A, 0, "dev.near", 50, 1),
      pay(FUND, 0, "dev.near", 40, 2, 3), // only one DAO behind it yet: not qualified
      pay(B, 0, "dev.near", 50, 3),
      pay(FUND, 1, "dev.near", 40, 4, 3), // now A + B: fast-laned, 3 votes saved
    ];
    const r = simulate({ payouts }, cfg());
    expect(r.payouts_considered).toBe(2);
    expect(r.not_qualified).toBe(1);
    expect(r.fast_laned).toBe(1);
    expect(r.votes_saved).toBe(3);
    expect(r.amount_fast_laned).toBe("40");
  });

  it("enforces the per-account cap and the period budget like the contract", () => {
    const history = [pay(A, 0, "x.near", 50, 1), pay(B, 0, "x.near", 50, 1), pay(A, 1, "y.near", 50, 1), pay(B, 1, "y.near", 50, 1)];
    const payouts = [
      ...history,
      pay(FUND, 0, "x.near", 80, 5),
      pay(FUND, 1, "x.near", 30, 6), // 80 + 30 > cap 100
      pay(FUND, 2, "y.near", 60, 7), // 80 + 60 = 140 <= budget 150
      pay(FUND, 3, "y.near", 20, 8), // 140 + 20 > budget 150
    ];
    const r = simulate({ payouts }, cfg());
    expect([r.fast_laned, r.blocked_by_cap, r.blocked_by_budget]).toEqual([2, 1, 1]);
    expect(r.max_period_amount).toBe("140");
  });

  it("ignores untrusted DAOs and dust", () => {
    const payouts = [
      pay("ring.sputnik-dao.near", 0, "z.near", 500, 1),
      pay(A, 0, "z.near", 1, 1), // below the floor of 10
      pay(B, 0, "z.near", 50, 1),
      pay(FUND, 0, "z.near", 40, 5),
    ];
    expect(simulate({ payouts }, cfg()).fast_laned).toBe(0);
  });
});

describe("discoverClaims", () => {
  it("prefers distinct DAOs and caps at nine claims", () => {
    const payouts = [
      ...Array.from({ length: 12 }, (_, i) => pay(A, i, "d.near", 50, i + 1)),
      pay(B, 0, "d.near", 50, 1),
    ];
    const claims = discoverClaims(payouts, "d.near", cfg().rules);
    expect(claims).toHaveLength(9);
    expect(new Set(claims.map((c) => c.dao_id))).toEqual(new Set([A, B]));
  });
});

describe("suggestTrusted", () => {
  it("ranks DAOs by contributors shared with the target", () => {
    const payouts = [
      pay(FUND, 0, "p.near", 50, 1),
      pay(FUND, 1, "q.near", 50, 1),
      pay(A, 0, "p.near", 50, 1),
      pay(A, 1, "q.near", 50, 1),
      pay(B, 0, "q.near", 50, 1),
      pay("other.sputnik-dao.near", 0, "nobody.near", 50, 1),
    ];
    expect(suggestTrusted(payouts, FUND)).toEqual([FUND, A, B]);
  });
});
