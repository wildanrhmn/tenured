// The operations behind the CLI and the MCP server, as plain async
// functions that return data.

import { defaultRules } from "./cli.js";
import { summarize, type Claim, type Rules, type Summary } from "./rules.js";
import { discoverClaims, membersOf, simulate, suggestTrusted, type SimConfig, type SimResult } from "./simulate.js";
import { loadSnapshot } from "./snapshot.js";
import { TOKENS, units } from "./tokens.js";
import { rpcFor, scanClaims, verifyLive, type Network } from "./verify.js";

export { scanClaims, verifyLive };
export type { ClaimCheck, Network, Verification } from "./verify.js";

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
        description: "Tenured fast lane payout",
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
