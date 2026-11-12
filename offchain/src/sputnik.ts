// Shapes returned by the Sputnik v2 contract (sputnikdao2) view methods.
// Only the fields we read are typed; everything else passes through.

export type ProposalStatus =
  | "InProgress"
  | "Approved"
  | "Rejected"
  | "Removed"
  | "Expired"
  | "Moved"
  | "Failed";

export type ActionCall = {
  method_name: string;
  args: string; // base64 JSON
  deposit: string;
  gas: string | number;
};

export type ProposalKind =
  | string // unit variants such as "Vote", "UpgradeSelf" come through as plain strings
  | { Transfer: { token_id: string; receiver_id: string; amount: string; msg?: string | null } }
  | { BountyDone: { bounty_id: number; receiver_id: string } }
  | { AddBounty: { bounty: { description: string; token: string; amount: string; times: number; max_deadline: string } } }
  | { FunctionCall: { receiver_id: string; actions: ActionCall[] } }
  | Record<string, unknown>;

export type Proposal = {
  id: number;
  proposer: string;
  description: string;
  kind: ProposalKind;
  status: ProposalStatus;
  vote_counts: Record<string, [string | number, string | number, string | number]>;
  votes: Record<string, string>;
  submission_time: string;
};

export type RoleKind = "Everyone" | { Group: string[] } | { Member: string };

export type Policy = {
  roles: { name: string; kind: RoleKind; permissions: string[]; vote_policy: Record<string, unknown> }[];
  default_vote_policy: unknown;
  proposal_bond: string;
  proposal_period: string;
  bounty_bond: string;
  bounty_forgiveness_period: string;
};

export const MAINNET_FACTORY = "sputnik-dao.near";
export const TESTNET_FACTORY = "sputnikv2.testnet";

export function kindName(kind: ProposalKind): string {
  return typeof kind === "string" ? kind : Object.keys(kind)[0] ?? "Unknown";
}

// RULES.md §1 rule 1: only the factory can create `<name>.<factory>`, so a
// direct sub-account of the factory is guaranteed to be a Sputnik DAO.
export function isFactoryDao(daoId: string, factory: string): boolean {
  if (!daoId.endsWith("." + factory)) return false;
  const name = daoId.slice(0, -(factory.length + 1));
  return name.length > 0 && !name.includes(".");
}

export const NO_CODE_HASH = "11111111111111111111111111111111";

/// Code versions the factory publishes: [code_hash, { version, commit_id }].
export type ContractMetadata = [string, { version: [number, number]; commit_id: string; changelog_url: string | null }];
