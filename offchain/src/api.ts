// The operations behind the CLI and the MCP server, as plain async
// functions that return data.

import { defaultRules, TOKENS, units } from "./cli.js";
import { MAINNET_RPCS, TESTNET_RPCS, RpcPool, ViewError } from "./rpc.js";
import { checkClaim, staticChecks, summarize, type Claim, type Reject, type Rules, type Summary } from "./rules.js";
import { discoverClaims, MAX_CLAIMS, membersOf, simulate, suggestTrusted, type SimConfig, type SimResult } from "./simulate.js";
import { loadSnapshot } from "./snapshot.js";
import { MAINNET_FACTORY, NO_CODE_HASH, TESTNET_FACTORY, type ContractMetadata, type Proposal } from "./sputnik.js";

export type Network = "mainnet" | "testnet";

const rpcFor = (n: Network) => new RpcPool(n === "testnet" ? TESTNET_RPCS : MAINNET_RPCS);
const factoryFor = (n: Network) => (n === "testnet" ? TESTNET_FACTORY : MAINNET_FACTORY);

export type ClaimCheck = Claim & { ok: boolean; reason: Reject | null };
export type Verification = {
  account_id: string;
  network: Network;
  results: ClaimCheck[];
  summary: Summary;
  code_versions: Record<string, string>;
  warnings: string[];
};

/// Same rules as the verifier contract, read live from each paying DAO,
/// plus the off-chain code check from RULES.md §8.
export async function verifyLive(account: string, claims: Claim[], rules: Rules, network: Network): Promise<Verification> {
  const rpc = rpcFor(network);
  const factory = factoryFor(network);
  const statics = staticChecks(claims, rules, factory);
  const policies = new Map<string, unknown>();
  const readOrNull = async (dao: string, method: string, args: object) => {
    try {
      return await rpc.view(dao, method, args);
    } catch (e) {
      if (!(e instanceof ViewError && e.kind === "contract")) throw e;
      return null;
    }
  };
  const results: ClaimCheck[] = [];
  for (const [i, c] of claims.entries()) {
    let reason = statics[i] ?? null;
    if (!reason) {
      const raw = await readOrNull(c.dao_id, "get_proposal", { id: c.proposal_id });
      if (rules.exclude_members && !policies.has(c.dao_id)) policies.set(c.dao_id, await readOrNull(c.dao_id, "get_policy", {}));
      reason = checkClaim(raw, policies.get(c.dao_id), account, rules);
    }
    results.push({ ...c, ok: reason === null, reason });
  }
  const published = new Map(
    (await rpc.view<ContractMetadata[]>(factory, "get_contracts_metadata").catch(() => [] as ContractMetadata[])).map(
      ([hash, m]) => [hash, m.version.join(".")],
    ),
  );
  const code_versions: Record<string, string> = {};
  for (const dao of new Set(results.filter((r) => r.ok).map((r) => r.dao_id))) {
    const hash = await rpc.codeHash(dao);
    code_versions[dao] = hash === NO_CODE_HASH ? "none" : (published.get(hash) ?? "custom");
  }
  const warnings = Object.entries(code_versions)
    .filter(([, v]) => v === "none" || v === "custom")
    .map(([dao, v]) => `${dao} runs ${v === "none" ? "no contract" : "code its factory never published"}; trust it with care (RULES.md §8)`);
  return {
    account_id: account,
    network,
    results,
    summary: summarize(results.filter((r) => r.ok), rules),
    code_versions,
    warnings,
  };
}

/// Approved Transfer payouts to `account` in `daos`, read live. Used where
/// there is no snapshot (testnet) or when fresh data matters.
export async function scanClaims(account: string, daos: string[], rules: Rules, network: Network): Promise<Claim[]> {
  const rpc = rpcFor(network);
  const found: { claim: Claim; time: bigint }[] = [];
  for (const dao of daos) {
    const last = await rpc.view<number>(dao, "get_last_proposal_id").catch(() => 0);
    const policy = rules.exclude_members ? await rpc.view(dao, "get_policy").catch(() => null) : undefined;
    for (let from = 0; from < last; from += 100) {
      const page = await rpc.view<Proposal[]>(dao, "get_proposals", { from_index: from, limit: 100 });
      for (const p of page) {
        if (checkClaim(p, policy, account, rules) === null) {
          found.push({ claim: { dao_id: dao, proposal_id: p.id }, time: BigInt(p.submission_time) });
        }
      }
    }
  }
  // Same preference as discoverClaims: distinct DAOs first, then newest.
  found.sort((a, b) => (b.time > a.time ? 1 : b.time < a.time ? -1 : 0));
  const picked: Claim[] = [];
  const seen = new Set<string>();
  for (const f of found) if (!seen.has(f.claim.dao_id) && picked.length < MAX_CLAIMS) (seen.add(f.claim.dao_id), picked.push(f.claim));
  for (const f of found) if (!picked.includes(f.claim) && picked.length < MAX_CLAIMS) picked.push(f.claim);
  return picked;
}

export async function findClaims(account: string, trusted: string[], rules: Rules): Promise<{ claims: Claim[]; summary: Summary; snapshot: string }> {
  const snap = await loadSnapshot();
  const claims = discoverClaims(snap.payouts, account, { ...rules, trusted_daos: trusted }, undefined, membersOf(snap.daos));
  return { claims, summary: summarize(claims, rules), snapshot: snap.crawled_to };
}

export async function suggestTrust(dao: string, count = 10): Promise<string[]> {
  return suggestTrusted((await loadSnapshot()).payouts, dao, count);
}

export async function simulateDao(
  dao: string,
  opts: {
    token?: string;
    cap?: string;
    budget?: string;
    period_days?: number;
    trusted?: string[];
    min_daos?: number;
    min_payouts?: number;
    exclude_members?: boolean;
  } = {},
): Promise<{ config: SimConfig; result: SimResult }> {
  const snap = await loadSnapshot();
  const token = TOKENS[opts.token ?? "near"];
  if (!token) throw new Error(`unknown token; one of ${Object.keys(TOKENS).join(", ")}`);
  const trusted = opts.trusted?.length ? opts.trusted : suggestTrusted(snap.payouts, dao);
  const rules = defaultRules(trusted, {
    "min-daos": String(opts.min_daos ?? 2),
    "min-payouts": String(opts.min_payouts ?? 3),
    ...(opts.exclude_members ? { "exclude-members": true as const } : {}),
  });
  const config: SimConfig = {
    dao,
    rules,
    pay_token: token.id,
    per_account_cap: units(opts.cap ?? "500", token.decimals),
    period_budget: units(opts.budget ?? "2000", token.decimals),
    period_secs: (opts.period_days ?? 30) * 86_400,
  };
  return { config, result: simulate(snap, config) };
}

export type LaneConfig = {
  rules: Rules;
  pay_token: string;
  per_account_cap: string;
  period_budget: string;
  period_secs: number;
  veto_secs: number;
  max_proposal_age_secs: number;
  guardians: string[];
};

export type Step = { signer: string; contract: string; method: string; args: object; deposit_yocto: string; gas_tgas: number; near_cli: string };

/// Everything an account (human or agent) needs to sign to request a
/// fast-lane payout: the proposal, then the registration. Nothing is signed
/// here; the plan is handed to the account's own wallet.
export async function lanePlan(
  account: string,
  lane: string,
  amount: string,
  network: Network,
  claims?: Claim[],
  nonce = Date.now(),
): Promise<{ dao: string; config: LaneConfig; claims: Claim[]; qualifies: boolean; steps: Step[] }> {
  const rpc = rpcFor(network);
  const dao = await rpc.view<string>(lane, "get_dao");
  const config = await rpc.view<LaneConfig>(lane, "get_config");
  const policy = await rpc.view<{ proposal_bond: string }>(dao, "get_policy");
  const nextId = await rpc.view<number>(dao, "get_last_proposal_id");
  const storage = await rpc.view<string>(lane, "storage_deposit");
  const use = claims ?? (await scanClaims(account, config.rules.trusted_daos, config.rules, network));
  const check = await verifyLive(account, use, config.rules, network);

  const cli = (s: Omit<Step, "near_cli">) =>
    `near contract call-function as-transaction ${s.contract} ${s.method} json-args '${JSON.stringify(s.args)}' ` +
    `prepaid-gas '${s.gas_tgas}.0 Tgas' attached-deposit '${s.deposit_yocto} yoctonear' sign-as ${s.signer} ` +
    `network-config ${network} sign-with-keychain send`;
  const propose = {
    signer: account,
    contract: dao,
    method: "add_proposal",
    args: {
      proposal: {
        description: "Track Record fast lane payout",
        kind: { Transfer: { token_id: config.pay_token, receiver_id: account, amount } },
      },
    },
    deposit_yocto: policy.proposal_bond,
    gas_tgas: 50,
  };
  const register = {
    signer: account,
    contract: lane,
    method: "register",
    // proposal_id is the id add_proposal returns; nextId is what it will be
    // unless someone else files a proposal first.
    args: { proposal_id: nextId, amount, claims: use, nonce },
    deposit_yocto: storage, // the request's storage, paid by the caller
    gas_tgas: 300,
  };
  return {
    dao,
    config,
    claims: use,
    qualifies: check.summary.qualifies,
    steps: [propose, register].map((s) => ({ ...s, near_cli: cli(s) })),
  };
}
