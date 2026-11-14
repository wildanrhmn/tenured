// tenured CLI.
//
//   npm run cli -- claims  <account> --trust-like <dao>
//   npm run cli -- verify  <account> --trust-like <dao> [--claims dao#id,dao#id]
//   npm run cli -- simulate <dao> [--token usdc] [--cap 500] [--budget 2000]
//
// `claims` and `simulate` read the committed snapshot. `verify` reads the
// paying DAOs live over RPC and applies the same rules as the verifier
// contract, so anyone can check a mainnet record without deploying anything.

import { verifyLive } from "./verify.js";
import { summarize, type Claim, type Rules } from "./rules.js";
import { discoverClaims, simulate, suggestTrusted, type SimConfig } from "./simulate.js";
import { loadSnapshot } from "./snapshot.js";
import { TOKENS, defaultRules as bar, human, units } from "./tokens.js";

export { TOKENS, human, units };

type Flags = Record<string, string | true>;

function parse(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) (flags[a.slice(2)] = next), i++;
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const flag = (f: Flags, k: string, d: string) => (typeof f[k] === "string" ? (f[k] as string) : d);

/// Default bar from RULES.md: payouts of at least 1 NEAR or 10 USD-stables,
/// from at least 2 trusted DAOs, at least 3 payouts in total.
export function defaultRules(trusted: string[], f: Flags = {}): Rules {
  return bar(trusted, {
    minNear: flag(f, "min-near", "1"),
    minDaos: Number(flag(f, "min-daos", "2")),
    minPayouts: Number(flag(f, "min-payouts", "3")),
    excludeMembers: f["exclude-members"] === true,
  });
}

async function trusted(f: Flags): Promise<string[]> {
  if (typeof f.trust === "string") return f.trust.split(",").map((s) => s.trim());
  if (typeof f["trust-like"] === "string") {
    const snap = await loadSnapshot();
    return suggestTrusted(snap.payouts, f["trust-like"], Number(flag(f, "trust-count", "10")));
  }
  throw new Error("say which DAOs to trust: --trust a,b,c or --trust-like <dao>");
}

const out = (f: Flags, v: unknown, text: () => string) => console.log(f.json ? JSON.stringify(v, null, 2) : text());

async function cmdClaims(pos: string[], f: Flags) {
  const account = pos[0];
  if (!account) throw new Error("usage: claims <account> --trust-like <dao>");
  const snap = await loadSnapshot();
  const rules = defaultRules(await trusted(f), f);
  const claims = discoverClaims(snap.payouts, account, rules);
  const s = summarize(claims, rules);
  out(f, { account, claims, summary: s }, () =>
    [
      `${account}: ${claims.length} claimable payouts from ${s.distinct_daos} trusted DAOs (snapshot ${snap.crawled_to.slice(0, 10)})`,
      ...claims.map((c) => `  ${c.dao_id}#${c.proposal_id}`),
      s.qualifies ? "meets the bar" : `below the bar (needs ${rules.min_distinct_daos} DAOs, ${rules.min_payouts} payouts)`,
    ].join("\n"),
  );
}

async function cmdVerify(pos: string[], f: Flags) {
  const account = pos[0];
  if (!account) throw new Error("usage: verify <account> --trust-like <dao> [--claims dao#id,...]");
  const testnet = flag(f, "network", "mainnet") === "testnet";
  const rules = defaultRules(await trusted(f), f);
  let claims: Claim[];
  if (typeof f.claims === "string") {
    claims = f.claims.split(",").map((s) => {
      const [dao_id, id] = s.split("#");
      return { dao_id: dao_id!, proposal_id: Number(id) };
    });
  } else {
    claims = discoverClaims((await loadSnapshot()).payouts, account, rules);
  }
  if (claims.length === 0) throw new Error("no claims to verify");

  const { results, summary: s, code_versions: code, warnings } = await verifyLive(account, claims, rules, testnet ? "testnet" : "mainnet");
  const published = Object.keys(code).length > 0;

  out(f, { account_id: account, results, summary: s, code_versions: code, warnings }, () =>
    [
      `${account} on ${testnet ? "testnet" : "mainnet"}, read live from each DAO:`,
      ...results.map((r) => `  ${r.ok ? "ok " : "no "} ${r.dao_id}#${r.proposal_id}${r.reason ? `  (${r.reason})` : ""}`),
      `${s.payouts} valid payouts from ${s.distinct_daos} DAOs: ${s.qualifies ? "qualifies" : "does not qualify"}`,
      ...Object.entries(code).map(([dao, v]) => `  code: ${dao} = ${published && v !== "custom" && v !== "none" ? `Sputnik ${v}` : v}`),
      ...warnings.map((w) => `warning: ${w}`),
    ].join("\n"),
  );
}

async function cmdSimulate(pos: string[], f: Flags) {
  const dao = pos[0];
  if (!dao) throw new Error("usage: simulate <dao> [--token near|usdc|...] [--cap N] [--budget N] [--period-days N]");
  const snap = await loadSnapshot();
  const token = TOKENS[flag(f, "token", "near")];
  if (!token) throw new Error(`unknown token; one of ${Object.keys(TOKENS).join(", ")}`);
  const trust = typeof f.trust === "string" || typeof f["trust-like"] === "string" ? await trusted(f) : suggestTrusted(snap.payouts, dao);
  const cfg: SimConfig = {
    dao,
    rules: defaultRules(trust, f),
    pay_token: token.id,
    per_account_cap: units(flag(f, "cap", "500"), token.decimals),
    period_budget: units(flag(f, "budget", "2000"), token.decimals),
    period_secs: Number(flag(f, "period-days", "30")) * 86_400,
  };
  const r = simulate(snap, cfg);
  out(f, { config: cfg, result: r }, () =>
    [
      `${dao}: ${r.payouts_considered} past payouts in ${flag(f, "token", "near")} (snapshot ${snap.crawled_to.slice(0, 10)})`,
      `  trusted: ${trust.join(", ")}`,
      `  would have skipped a vote: ${r.fast_laned} payouts, ${r.votes_saved} council votes saved`,
      `  not enough track record:   ${r.not_qualified}`,
      `  stopped by cap / budget:   ${r.blocked_by_cap} / ${r.blocked_by_budget}`,
      `  most the lane ever moved in one period: ${human(r.max_period_amount, token.decimals)} (budget ${flag(f, "budget", "2000")})`,
    ].join("\n"),
  );
}

const HELP = `tenured <command>

  claims   <account> --trust-like <dao>      best claims an account can present (from the snapshot)
  verify   <account> --trust-like <dao>      verify live against the DAOs' own proposals
           [--claims dao#id,...] [--network mainnet|testnet]
  simulate <dao> [--token near|usdc|usdt|...] [--cap 500] [--budget 2000] [--period-days 30]

  common:  --trust a,b,c   explicit trusted DAOs     --min-daos 2   --min-payouts 3
           --min-near 1    smallest NEAR payout that counts
           --exclude-members   don't count payouts to members of the paying DAO   --json`;

async function main() {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  if (cmd === "claims") return cmdClaims(pos, flags);
  if (cmd === "verify") return cmdVerify(pos, flags);
  if (cmd === "simulate") return cmdSimulate(pos, flags);
  console.log(HELP);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
