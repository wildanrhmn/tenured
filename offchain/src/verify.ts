// Live checks against the paying DAOs, with the same rules as the verifier
// contract. Used by the CLI, the MCP server (through api.ts) and the web
// app, so nothing here touches Node APIs.

import { MAINNET_RPCS, TESTNET_RPCS, RpcPool, ViewError } from "./rpc.js";
import { checkClaim, staticChecks, summarize, type Claim, type Reject, type Rules, type Summary } from "./rules.js";
import { MAX_CLAIMS } from "./simulate.js";
import { MAINNET_FACTORY, NO_CODE_HASH, TESTNET_FACTORY, type ContractMetadata, type Proposal } from "./sputnik.js";

export type Network = "mainnet" | "testnet";

export const rpcFor = (n: Network) => new RpcPool(n === "testnet" ? TESTNET_RPCS : MAINNET_RPCS);
export const factoryFor = (n: Network) => (n === "testnet" ? TESTNET_FACTORY : MAINNET_FACTORY);

export type ClaimCheck = Claim & { ok: boolean; reason: Reject | null };
export type Verification = {
  account_id: string;
  network: Network;
  results: ClaimCheck[];
  summary: Summary;
  code_versions: Record<string, string>;
  warnings: string[];
};

/// Optional hooks for callers that show progress (the web app): reuse an
/// RPC pool, and hear about each claim as soon as it is checked.
export type LiveOptions = { rpc?: RpcPool; onResult?: (r: ClaimCheck, index: number) => void };

/// Same rules as the verifier contract, read live from each paying DAO,
/// plus the off-chain code check from RULES.md §8.
export async function verifyLive(account: string, claims: Claim[], rules: Rules, network: Network, opts: LiveOptions = {}): Promise<Verification> {
  const rpc = opts.rpc ?? rpcFor(network);
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
    opts.onResult?.(results[i]!, i);
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
export async function scanClaims(account: string, daos: string[], rules: Rules, network: Network, opts: Pick<LiveOptions, "rpc"> = {}): Promise<Claim[]> {
  const rpc = opts.rpc ?? rpcFor(network);
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
