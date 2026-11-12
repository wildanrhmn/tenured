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
  | "BelowFloor";
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

const isDecimal = (s: unknown): s is string => typeof s === "string" && /^[0-9]+$/.test(s);

export function checkProposal(raw: unknown, claimant: string, rules: Rules): Reject | null {
  if (raw === undefined || raw === null) return "NotFound";
  const p = raw as Record<string, unknown>;
  const t = p.submission_time;
  const timeOk = isDecimal(t) || (typeof t === "number" && Number.isInteger(t) && t >= 0);
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

export function summarize(valid: Claim[], rules: Rules): Summary {
  const distinct_daos = new Set(valid.map((c) => c.dao_id)).size;
  const payouts = valid.length;
  return {
    distinct_daos,
    payouts,
    qualifies: distinct_daos >= rules.min_distinct_daos && payouts >= rules.min_payouts,
  };
}
