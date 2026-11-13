// `npm run judge`: one command that checks the claims in the README.
// No keys, no funds. Offline checks always run; live checks read public RPC.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { MAINNET_RPCS, TESTNET_RPCS, RpcPool, ViewError } from "./rpc.js";
import { checkClaim, checkProposal, staticChecks, summarize, type Claim } from "./rules.js";
import { buildReport, REPORT } from "./report.js";
import { loadSnapshot } from "./snapshot.js";
import { TESTNET_FACTORY } from "./sputnik.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

export const DEPLOYMENT = {
  network: "testnet",
  verifier: "trackrecord-verifier.testnet",
  lane: "trackrecord-lane.testnet",
  fund: "trackrecord-fund.sputnikv2.testnet",
  contributor: "trackrecord-dev.testnet",
  claims: [
    { dao_id: "trackrecord-alpha.sputnikv2.testnet", proposal_id: 0 },
    { dao_id: "trackrecord-alpha.sputnikv2.testnet", proposal_id: 1 },
    { dao_id: "trackrecord-beta.sputnikv2.testnet", proposal_id: 0 },
  ] as Claim[],
};

type Check = { name: string; run: () => Promise<string> };
const checks: Check[] = [];
const check = (name: string, run: () => Promise<string>) => checks.push({ name, run });

check("report.json reproduces from the committed snapshot", async () => {
  const committed = JSON.parse(await readFile(REPORT, "utf8"));
  const fresh = buildReport(await loadSnapshot());
  if (JSON.stringify(fresh) !== JSON.stringify(committed)) throw new Error("report differs from snapshot; run npm run reproduce");
  return `${fresh.daos.total} DAOs, ${fresh.payouts.total} payouts, ${fresh.receivers.total} receivers`;
});

check("TypeScript rules match the Rust rules on fixtures/claims.json", async () => {
  const f = JSON.parse(await readFile(path.join(ROOT, "fixtures/claims.json"), "utf8"));
  let n = 0;
  for (const c of f.static_cases) {
    if (JSON.stringify(staticChecks(c.claims, f.rules, f.factory)) !== JSON.stringify(c.expect)) throw new Error(c.name);
    n++;
  }
  for (const c of f.proposal_cases) {
    if (checkProposal(c.proposal, c.claimant, f.rules) !== c.expect) throw new Error(c.name);
    n++;
  }
  for (const c of f.member_cases) {
    if (checkClaim(f.member_proposal, c.policy, c.claimant, { ...f.rules, exclude_members: c.exclude_members }) !== c.expect) throw new Error(c.name);
    n++;
  }
  for (const c of f.summary_cases) {
    if (JSON.stringify(summarize(c.valid, f.rules)) !== JSON.stringify(c.expect)) throw new Error(c.name);
    n++;
  }
  return `${n} shared cases agree (the Rust side runs the same file in cargo test)`;
});

check("snapshot payouts match mainnet, read live", async () => {
  const snap = await loadSnapshot();
  const transfers = snap.payouts.filter((p) => p.path === "transfer");
  // A fixed, spread-out sample so reruns read the same proposals.
  const step = Math.max(1, Math.floor(transfers.length / 5));
  const sample = [0, 1, 2, 3, 4].map((i) => transfers[i * step]!).filter(Boolean);
  const rpc = new RpcPool(MAINNET_RPCS);
  for (const p of sample) {
    const live = await rpc.view<Record<string, any>>(p.dao, "get_proposal", { id: p.proposal_id });
    const t = live?.kind?.Transfer;
    if (live?.status !== "Approved" || t?.receiver_id !== p.receiver || t?.amount !== p.amount || t?.token_id !== p.token) {
      throw new Error(`${p.dao}#${p.proposal_id} differs on chain`);
    }
  }
  return `${sample.length} sampled payouts identical on chain`;
});

check("testnet: the lane is a role with exactly one permission", async () => {
  const rpc = new RpcPool(TESTNET_RPCS);
  const policy = await rpc.view<{ roles: { name: string; kind: any; permissions: string[] }[] }>(DEPLOYMENT.fund, "get_policy");
  const roles = policy.roles.filter((r) => JSON.stringify(r.kind).includes(DEPLOYMENT.lane));
  if (roles.length !== 1) throw new Error(`lane appears in ${roles.length} roles`);
  const r = roles[0]!;
  if (JSON.stringify(r.permissions) !== JSON.stringify(["transfer:VoteApprove"])) throw new Error(`permissions ${r.permissions}`);
  return `${DEPLOYMENT.fund} role "${r.name}" = [${r.permissions.join(", ")}]`;
});

check("testnet: the lane's DAO and config", async () => {
  const rpc = new RpcPool(TESTNET_RPCS);
  const dao = await rpc.view<string>(DEPLOYMENT.lane, "get_dao");
  if (dao !== DEPLOYMENT.fund) throw new Error(`lane serves ${dao}`);
  const c = await rpc.view<any>(DEPLOYMENT.lane, "get_config");
  return `serves ${dao}; veto ${c.veto_secs}s; ${c.guardians.length} guardian(s); budget ${Number(BigInt(c.period_budget) / 10n ** 21n) / 1000} NEAR per ${c.period_secs / 86400} days`;
});

check("testnet: the contributor's record verifies against the DAOs", async () => {
  const rpc = new RpcPool(TESTNET_RPCS);
  const rules = {
    trusted_daos: [...new Set(DEPLOYMENT.claims.map((c) => c.dao_id))],
    tokens: [{ token_id: "", min_amount: "100000000000000000000000" }],
    min_distinct_daos: 2,
    min_payouts: 3,
  };
  const statics = staticChecks(DEPLOYMENT.claims, rules, TESTNET_FACTORY);
  const valid: Claim[] = [];
  for (const [i, c] of DEPLOYMENT.claims.entries()) {
    if (statics[i]) continue;
    let raw: unknown = null;
    try {
      raw = await rpc.view(c.dao_id, "get_proposal", { id: c.proposal_id });
    } catch (e) {
      if (!(e instanceof ViewError && e.kind === "contract")) throw e;
    }
    if (checkProposal(raw, DEPLOYMENT.contributor, rules) === null) valid.push(c);
  }
  const s = summarize(valid, rules);
  if (!s.qualifies) throw new Error(`only ${s.payouts} valid payouts from ${s.distinct_daos} DAOs`);
  return `${DEPLOYMENT.contributor}: ${s.payouts} payouts from ${s.distinct_daos} DAOs`;
});

check("testnet: lane requests and their outcomes", async () => {
  const rpc = new RpcPool(TESTNET_RPCS);
  const reqs = await rpc.view<{ status: unknown }[]>(DEPLOYMENT.lane, "get_requests", { from_index: 0, limit: 100 });
  const count: Record<string, number> = {};
  for (const r of reqs) {
    const s = typeof r.status === "string" ? r.status : Object.keys(r.status as object)[0]!;
    count[s] = (count[s] ?? 0) + 1;
  }
  return `${reqs.length} requests: ${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(", ") || "none yet"}`;
});

async function main() {
  const offline = process.argv.includes("--offline");
  let failed = 0;
  for (const c of checks) {
    if (offline && /live|testnet/.test(c.name)) {
      console.log(`[skip] ${c.name}`);
      continue;
    }
    try {
      console.log(`[ok]   ${c.name}\n       ${await c.run()}`);
    } catch (e) {
      failed++;
      console.log(`[FAIL] ${c.name}\n       ${(e as Error).message}`);
    }
  }
  console.log(`\njudge: ${checks.length} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
