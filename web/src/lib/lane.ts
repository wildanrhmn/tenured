// Read-only views of the deployed testnet demo (scripts/testnet-setup.sh).
// The testnet accounts keep the project's working name, trackrecord-*.

import { RpcPool, TESTNET_RPCS, human, type Policy } from "../engine";
import type { LaneConfig } from "./install";

export const DEMO = {
  lane: "trackrecord-lane.testnet",
  dao: "trackrecord-fund.sputnikv2.testnet",
  verifier: "trackrecord-verifier.testnet",
  dev: "trackrecord-dev.testnet",
  guardian: "trackrecord-guardian.testnet",
  council: "trackrecord-council.testnet",
  alpha: "trackrecord-alpha.sputnikv2.testnet",
  beta: "trackrecord-beta.sputnikv2.testnet",
} as const;

export type LaneStatus =
  | "Checking"
  | "Waiting"
  | "Approving"
  | "Approved"
  | "Voted"
  | { Vetoed: { by: string } }
  | { Refused: { reason: string } };

type Ns = number | string;

export type LaneRequest = {
  id: number;
  account_id: string;
  proposal_id: number;
  amount: string;
  nonce: number;
  period: number;
  registered_at_ns: Ns;
  executable_at_ns: Ns;
  /** When the DAO's proposal expires; 0 until the lane has read it. */
  expires_at_ns: Ns;
  approving_at_ns: Ns;
  distinct_daos: number;
  payouts: number;
  status: LaneStatus;
};

export type Usage = {
  period: number;
  used_by_account: string;
  used_by_period: string;
  per_account_cap: string;
  period_budget: string;
};

export type StatusName = "Checking" | "Waiting" | "Vetoed" | "Approving" | "Voted" | "Approved" | "Refused";
export type StatusView = { name: StatusName; detail?: string };

export function statusView(s: LaneStatus): StatusView {
  if (s === "Voted") return { name: s, detail: "The lane voted but the DAO hasn't approved; the amount stays counted until recheck settles it" };
  if (typeof s === "string") return { name: s };
  if ("Vetoed" in s) return { name: "Vetoed", detail: `by ${s.Vetoed.by}` };
  return { name: "Refused", detail: s.Refused.reason };
}

/** Nanosecond timestamps arrive as JSON numbers past 2^53; this is precise enough for a countdown. */
export const nsToMs = (ns: Ns) => Number(BigInt(String(ns).split(".")[0]!) / 1_000_000n);

export function vetoRemainingSecs(req: LaneRequest, nowMs: number): number | null {
  const at = nsToMs(req.executable_at_ns);
  if (statusView(req.status).name !== "Waiting" || at === 0) return null;
  return Math.max(0, (at - nowMs) / 1000);
}

/** Seconds until the DAO's proposal expires, for requests that can still move. */
export function expiresInSecs(req: LaneRequest, nowMs: number): number | null {
  const at = nsToMs(req.expires_at_ns ?? 0);
  const name = statusView(req.status).name;
  if (at === 0 || !(name === "Waiting" || name === "Voted" || name === "Approving")) return null;
  return (at - nowMs) / 1000;
}

let pool: RpcPool | null = null;
export const testnet = () => (pool ??= new RpcPool(TESTNET_RPCS, 150, 10_000));

/** The lane returns at most this many requests per call. */
const PAGE = 100;

export type LiveState = {
  config: LaneConfig;
  dao: string;
  requests: LaneRequest[];
  policy: Policy;
  proposals: Map<number, { status: string } | null>;
  usage: Usage;
  verifierFactory: string | null;
  /** The id the next proposal filed in the DAO will get. */
  nextProposalId: number;
  /** What register() must attach, in yoctoNEAR. */
  storageDeposit: string;
  readAt: number;
};

export async function readLive(): Promise<LiveState> {
  const rpc = testnet();
  const config = await rpc.view<LaneConfig>(DEMO.lane, "get_config");
  const dao = await rpc.view<string>(DEMO.lane, "get_dao");
  const requests: LaneRequest[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await rpc.view<LaneRequest[]>(DEMO.lane, "get_requests", { from_index: from, limit: PAGE });
    requests.push(...page);
    if (page.length < PAGE) break;
  }
  const policy = await rpc.view<Policy>(dao, "get_policy");
  const usage = await rpc.view<Usage>(DEMO.lane, "get_usage", { account_id: DEMO.dev });
  const proposals = new Map<number, { status: string } | null>();
  for (const r of requests.slice(-12)) {
    proposals.set(r.proposal_id, await rpc.view<{ status: string }>(dao, "get_proposal", { id: r.proposal_id }).catch(() => null));
  }
  const verifierFactory = await rpc.view<string>(DEMO.verifier, "factory").catch(() => null);
  const nextProposalId = await rpc.view<number>(dao, "get_last_proposal_id");
  const storageDeposit = await rpc.view<string>(DEMO.lane, "storage_deposit").catch(() => "10000000000000000000000");
  return { config, dao, requests, policy, proposals, usage, verifierFactory, nextProposalId, storageDeposit, readAt: Date.now() };
}

export type DemoInputs = {
  amountYocto: string;
  proposalId: string;
  requestId: string;
  /** The DAO's proposal bond, in yoctoNEAR. */
  bond: string;
  /** The lane's storage_deposit(), in yoctoNEAR. */
  storageDeposit: string;
};

/** Copyable near CLI commands, mirroring scripts/testnet-demo.sh. */
export function demoCommands(d: DemoInputs) {
  const net = "network-config testnet sign-with-legacy-keychain send";
  const transfer = { Transfer: { token_id: "", receiver_id: DEMO.dev, amount: d.amountYocto } };
  const claims = [
    { dao_id: DEMO.alpha, proposal_id: 0 },
    { dao_id: DEMO.alpha, proposal_id: 1 },
    { dao_id: DEMO.beta, proposal_id: 0 },
  ];
  const id = Number(d.requestId) || 0;
  const call = (method: string, args: string, gas: string, deposit: string, signer: string) =>
    [
      `near contract call-function as-transaction ${method === "add_proposal" ? DEMO.dao : DEMO.lane} ${method} \\`,
      `  json-args '${args}' \\`,
      `  prepaid-gas '${gas} Tgas' attached-deposit '${deposit} NEAR' \\`,
      `  sign-as ${signer} ${net}`,
    ].join("\n");
  return {
    file: call(
      "add_proposal",
      JSON.stringify({ proposal: { description: "Fast lane payout", kind: transfer } }),
      "300.0",
      human(d.bond, 24),
      DEMO.dev,
    ),
    register: call(
      "register",
      JSON.stringify({ proposal_id: Number(d.proposalId) || 0, amount: d.amountYocto, nonce: "NONCE", claims }).replace(
        '"NONCE"',
        "'$(date +%s)'",
      ),
      "300.0",
      human(d.storageDeposit, 24),
      DEMO.dev,
    ),
    execute: call("execute", `{"id":${id}}`, "300.0", "0", "<any-account>"),
    veto: call("veto", `{"id":${id}}`, "30.0", "0", DEMO.guardian),
    recheck: call("recheck", `{"id":${id}}`, "100.0", "0", "<any-account>"),
  };
}
