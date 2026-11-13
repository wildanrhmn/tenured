// Generates fixtures/random-claims.json: thousands of random, often
// malformed proposals and policies with the TypeScript verdicts. The Rust
// rules crate runs the same file, so any disagreement between the contracts
// and the offchain tools fails a test.
//
//   npm run fuzz -w offchain

import { writeFileSync } from "node:fs";
import path from "node:path";
import { checkClaim, staticChecks, type Claim, type Rules } from "./rules.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const RANDOM_FIXTURES = path.join(ROOT, "fixtures/random-claims.json");

// Small seeded PRNG (mulberry32) so the file is reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACTORY = "sputnik-dao.near";
const CLAIMANT = "dev.near";
const U128_MAX = (2n ** 128n - 1n).toString();

export const RULES: Rules = {
  trusted_daos: ["a.sputnik-dao.near", "b.sputnik-dao.near"],
  tokens: [
    { token_id: "", min_amount: "1000" },
    { token_id: "usdc.near", min_amount: "10" },
  ],
  min_distinct_daos: 2,
  min_payouts: 3,
};

export function generate(n = 5000, seed = 20261110) {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const maybe = (p: number) => r() < p;

  const amounts = ["0", "1", "9", "10", "999", "1000", "1001", "+1000", "-1", "1.5", "", " 1000", "1e3", "abc", "00001000", U128_MAX, U128_MAX + "0", "340282366920938463463374607431768211456"];
  const times = ["1700000000000000000", "0", "-1", "abc", "+5", "18446744073709551615", "18446744073709551616", 1700000000, -5, 1.5, null];
  const statuses = ["Approved", "InProgress", "Rejected", "Removed", "Expired", "Failed", "approved", "", 7];

  // Half the cases start from a valid payout and get zero to two targeted
  // mutations, so the success path and each single failure are well covered.
  const nearlyValid = () => {
    const p: Record<string, any> = {
      proposer: "boss.near",
      status: "Approved",
      submission_time: "1700000000000000000",
      kind: { Transfer: { token_id: pick(["", "usdc.near"]), receiver_id: CLAIMANT, amount: pick(["1000", "5000", "10", "99999", U128_MAX]), msg: null } },
    };
    // Mutations may replace the kind; later ones then write to a detached object.
    const tr = () => (p.kind?.Transfer ?? {}) as Record<string, unknown>;
    const mutations = [
      () => (p.status = pick(statuses)),
      () => (p.submission_time = pick(times)),
      () => (tr().amount = pick(amounts)),
      () => (tr().receiver_id = pick(["other.near", 1, CLAIMANT])),
      () => (tr().token_id = pick(["meme.near", 3, "", "usdc.near"])),
      () => delete tr().amount,
      () => (tr().msg = pick(["x", "", 5, null])),
      () => delete tr().msg,
      () => delete p.proposer,
      () => (p.kind = pick(["Vote", { AddMemberToRole: { member_id: CLAIMANT, role: "c" } }])),
    ];
    for (let i = Math.floor(r() * 3); i > 0; i--) pick(mutations)();
    return p;
  };

  const proposal = () => {
    if (maybe(0.5)) return nearlyValid();
    if (maybe(0.04)) return null;
    // Only the fields the rules read; the rest of a Sputnik proposal is ignored.
    const p: Record<string, unknown> = {
      proposer: maybe(0.95) ? pick([CLAIMANT, "boss.near"]) : pick([null, 5]),
      status: pick(statuses),
      submission_time: pick(times),
    };
    if (maybe(0.05)) delete p.status;
    if (maybe(0.05)) delete p.submission_time;
    const k = r();
    if (k < 0.7) {
      const t: Record<string, unknown> = {
        token_id: pick(["", "", "usdc.near", "meme.near", 3]),
        receiver_id: pick([CLAIMANT, CLAIMANT, "other.near", 1]),
        amount: pick(amounts),
        msg: pick([null, null, null, "x", "", 5]),
      };
      if (maybe(0.04)) delete t.amount;
      p.kind = { Transfer: t };
    } else if (k < 0.8) p.kind = "Vote";
    else if (k < 0.9) p.kind = { AddMemberToRole: { member_id: CLAIMANT, role: "council" } };
    else p.kind = { FunctionCall: { receiver_id: "x.near", actions: [] } };
    return p;
  };

  const policy = () => {
    const x = r();
    if (x < 0.1) return null;
    if (x < 0.15) return { roles: "nope" };
    const roles = [{ name: "all", kind: "Everyone", permissions: [] }];
    for (let i = 0; i < Math.floor(r() * 3); i++) {
      const members = [pick(["boss.near", "x.near"]), ...(maybe(0.4) ? [CLAIMANT] : [])];
      roles.push({ name: `r${i}`, kind: (maybe(0.1) ? { Group: "dev.near" } : { Group: members }) as never, permissions: [] });
    }
    return { roles };
  };

  const daoIds = ["a.sputnik-dao.near", "b.sputnik-dao.near", "c.sputnik-dao.near", "a.near", "x.a.sputnik-dao.near", "sputnik-dao.near", ".sputnik-dao.near"];

  const cases = [];
  for (let i = 0; i < n; i++) {
    const exclude_members = maybe(0.3);
    const rules = { ...RULES, exclude_members };
    const p = proposal();
    const pol = policy();
    cases.push({ proposal: p, policy: pol, exclude_members, expect: checkClaim(p, pol, CLAIMANT, rules) });
  }
  const statics = [];
  for (let i = 0; i < 300; i++) {
    const claims: Claim[] = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({ dao_id: pick(daoIds), proposal_id: Math.floor(r() * 3) }));
    statics.push({ claims, expect: staticChecks(claims, RULES, FACTORY) });
  }
  return { seed, factory: FACTORY, claimant: CLAIMANT, rules: RULES, cases, statics };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = generate();
  writeFileSync(RANDOM_FIXTURES, JSON.stringify(out) + "\n");
  const verdicts: Record<string, number> = {};
  for (const c of out.cases) verdicts[c.expect ?? "ok"] = (verdicts[c.expect ?? "ok"] ?? 0) + 1;
  console.log(`wrote ${out.cases.length} claim cases and ${out.statics.length} static cases`, verdicts);
}
