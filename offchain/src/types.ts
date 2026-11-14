// Plain data shapes shared by the crawler, the simulator and the web app.
// Nothing here touches Node APIs, so browsers can import it too.

export type PayoutPath = "transfer" | "bounty" | "ft_transfer" | "intents" | "bulk";

export type Payout = {
  dao: string;
  proposal_id: number;
  path: PayoutPath;
  receiver: string;
  token: string; // "" = native NEAR; otherwise the token contract or intents token id
  amount: string;
  time_ns: string;
  proposer: string;
  votes: number; // council votes it took to approve
};

/// Approved proposals whose effect can't be attributed to a receiver.
export type Opaque = { dao: string; proposal_id: number; reason: "chain_signature" | "bulk_list_missing" };

export type DaoInfo = {
  dao: string;
  proposals: number;
  code_hash: string | null;
  // Sputnik version if the code is one the factory published, "none" if the
  // account has no contract, null if it runs something else.
  code_version: string | null;
  proposal_bond: string | null;
  proposal_period_ns: string | null;
  // Members of Group roles, by role name. Used to spot self-dealing.
  groups: Record<string, string[]>;
  error?: string;
};

export type Snapshot = {
  version: 1;
  network: "mainnet";
  factory: string;
  crawled_from: string;
  crawled_to: string;
  factory_versions: { code_hash: string; version: string; commit_id: string }[];
  daos: DaoInfo[];
  payouts: Payout[];
  opaque: Opaque[];
};
