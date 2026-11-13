// TypeScript twin of contracts/rules (RULES.md §1, §2). Used for claim
// discovery and the simulator, never for money: the contracts re-check
// everything on-chain. Both implementations run fixtures/claims.json.

export type Claim = { dao_id: string; proposal_id: number };
export type TokenFloor = { token_id: string; min_amount: string };
export type Rules = {
  trusted_daos: string[];
  tokens: TokenFloor[];
  min_distinct_daos: number;
  min_payouts: number;
  // RULES.md §1 rule 9: don't count payouts to members of the paying DAO.
  exclude_members?: boolean;
};
export type Reject =
  | "NotFactoryDao"
  | "NotTrusted"
  | "Duplicate"
  | "NotFound"
  | "Unreadable"
  | "NotApproved"
  | "NotTransfer"
  | "WrongReceiver"
  | "TokenNotCounted"
  | "BelowFloor"
  | "DaoMember";
export type Summary = { distinct_daos: number; payouts: number; qualifies: boolean };

export function isFactoryDao(daoId: string, factory: string): boolean {
  if (!daoId.endsWith("." + factory)) return false;
  const name = daoId.slice(0, -(factory.length + 1));
  return name.length > 0 && !name.includes(".");
}

export function staticChecks(claims: Claim[], rules: Rules, factory: string): (Reject | null)[] {
  const seen = new Set<string>();
  return claims.map((c) => {
    const key = `${c.dao_id}#${c.proposal_id}`;
    let verdict: Reject | null = null;
    if (!isFactoryDao(c.dao_id, factory)) verdict = "NotFactoryDao";
    else if (!rules.trusted_daos.includes(c.dao_id)) verdict = "NotTrusted";
    else if (seen.has(key)) verdict = "Duplicate";
    seen.add(key);
    return verdict;
  });
}

// Canonical decimal, as Sputnik writes them: digits only and within the
// Rust type's range (u64 timestamps, u128 amounts). Matches dec_u64/dec_u128
// in contracts/rules.
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const isDecimal = (s: unknown, max = U128_MAX): s is string => typeof s === "string" && /^[0-9]+$/.test(s) && BigInt(s) <= max;

export function checkProposal(raw: unknown, claimant: string, rules: Rules): Reject | null {
  if (raw === undefined || raw === null) return "NotFound";
  const p = raw as Record<string, unknown>;
  const t = p.submission_time;
  const timeOk = isDecimal(t, U64_MAX) || (typeof t === "number" && Number.isSafeInteger(t) && t >= 0);
  if (typeof p.proposer !== "string" || typeof p.status !== "string" || !timeOk) return "Unreadable";
  if (p.status !== "Approved") return "NotApproved";
  const kind = p.kind as Record<string, unknown> | string | undefined;
  const tr = typeof kind === "object" && kind !== null ? (kind.Transfer as Record<string, unknown> | undefined) : undefined;
  if (!tr || typeof tr.token_id !== "string" || typeof tr.receiver_id !== "string" || typeof tr.amount !== "string") {
    return "NotTransfer";
  }
  if (tr.receiver_id !== claimant) return "WrongReceiver";
  const floor = rules.tokens.find((f) => f.token_id === tr.token_id);
  if (!floor) return "TokenNotCounted";
  if (!isDecimal(tr.amount) || !isDecimal(floor.min_amount)) return "Unreadable";
  if (BigInt(tr.amount) < BigInt(floor.min_amount)) return "BelowFloor";
  return null;
}

/// Whether `account` is in any Group role of a `get_policy` response.
export function isMember(policy: unknown, account: string): boolean {
  const roles = (policy as { roles?: unknown } | null)?.roles;
  if (!Array.isArray(roles)) return false;
  return roles.some((r) => {
    const g = (r as { kind?: { Group?: unknown } })?.kind?.Group;
    return Array.isArray(g) && g.includes(account);
  });
}

/// Rules 3 to 7, then rule 9 when members are excluded. A missing policy
/// counts as membership, so a failed read can only reject.
export function checkClaim(raw: unknown, policy: unknown, claimant: string, rules: Rules): Reject | null {
  const r = checkProposal(raw, claimant, rules);
  if (r) return r;
  if (rules.exclude_members && (policy === undefined || policy === null || isMember(policy, claimant))) return "DaoMember";
  return null;
}

export function summarize(valid: Claim[], rules: Rules): Summary {
  const distinct_daos = new Set(valid.map((c) => c.dao_id)).size;
  const payouts = valid.length;
  return {
    distinct_daos,
    payouts,
    qualifies: distinct_daos >= rules.min_distinct_daos && payouts >= rules.min_payouts,
  };
}
