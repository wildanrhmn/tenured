// Turns raw DAO proposals into payouts: who was paid, by which DAO, how
// much, and through which path (RULES.md §6). Only `transfer` payouts can be
// presented as on-chain claims today; the other paths feed the simulator
// and the coverage report.

import { kindName, type ActionCall, type Proposal } from "./sputnik.js";

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

// Shape of bulkpayment.near view_list (NEAR-DevHub/trezu contracts/bulk-payment).
export type BulkList = {
  missing?: boolean;
  token_id?: string;
  payments?: { recipient: string; amount: string; status: string | Record<string, unknown> }[];
};

const isPaid = (status: string | Record<string, unknown>) => typeof status === "object" && status !== null && "Paid" in status;

function decodeArgs(a: ActionCall): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(a.args, "base64").toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

export function extractPayouts(
  dao: string,
  proposals: Proposal[],
  bulk: (listId: string) => BulkList | undefined,
): { payouts: Payout[]; opaque: Opaque[] } {
  const payouts: Payout[] = [];
  const opaque: Opaque[] = [];

  // Bounty ids are handed out in order as AddBounty proposals are approved,
  // so the n-th approved AddBounty created bounty n.
  const bounties: { token: string; amount: string }[] = [];
  const sorted = [...proposals].sort((a, b) => a.id - b.id);
  for (const p of sorted) {
    if (p.status === "Approved" && typeof p.kind === "object" && "AddBounty" in p.kind) {
      const b = (p.kind as { AddBounty: { bounty: { token: string; amount: string } } }).AddBounty.bounty;
      bounties.push({ token: b.token, amount: b.amount });
    }
  }

  for (const p of sorted) {
    if (p.status !== "Approved") continue;
    const base = {
      dao,
      proposal_id: p.id,
      time_ns: String(p.submission_time),
      proposer: p.proposer,
      votes: Object.keys(p.votes ?? {}).length,
    };
    const k = p.kind;
    if (typeof k !== "object" || k === null) continue;

    if ("Transfer" in k) {
      const t = (k as { Transfer: { token_id: string; receiver_id: string; amount: string; msg?: string | null } }).Transfer;
      // With a msg the DAO paid through ft_transfer_call, which the receiver
      // can refund; like the contracts (RULES.md rule 4), don't treat it as
      // a claimable transfer.
      const path = t.msg === null || t.msg === undefined ? "transfer" : "ft_transfer";
      payouts.push({ ...base, path, receiver: t.receiver_id, token: t.token_id, amount: t.amount });
    } else if ("BountyDone" in k) {
      const b = (k as { BountyDone: { bounty_id: number; receiver_id: string } }).BountyDone;
      const bounty = bounties[b.bounty_id];
      if (bounty) payouts.push({ ...base, path: "bounty", receiver: b.receiver_id, token: bounty.token, amount: bounty.amount });
    } else if ("FunctionCall" in k) {
      const fc = (k as { FunctionCall: { receiver_id: string; actions: ActionCall[] } }).FunctionCall;
      for (const a of fc.actions) {
        const args = decodeArgs(a);
        if (a.method_name === "sign" && /(^|\.)v1\.signer$|^v1\.signer/.test(fc.receiver_id)) {
          opaque.push({ dao, proposal_id: p.id, reason: "chain_signature" });
          continue;
        }
        if (!args) continue;
        if ((a.method_name === "ft_transfer" || a.method_name === "ft_transfer_call") && fc.receiver_id !== "intents.near") {
          const receiver = str(args.receiver_id);
          const amount = str(args.amount);
          // ft_transfer_call into a contract (e.g. a DEX) is a trade, not pay.
          if (receiver && amount && a.method_name === "ft_transfer") {
            payouts.push({ ...base, path: "ft_transfer", receiver, token: fc.receiver_id, amount });
          }
        } else if (fc.receiver_id === "intents.near" && (a.method_name === "mt_transfer" || a.method_name === "ft_withdraw")) {
          const receiver = str(args.receiver_id);
          const amount = str(args.amount);
          const token = str(args.token_id) ?? str(args.token) ?? "";
          if (receiver && amount) payouts.push({ ...base, path: "intents", receiver, token, amount });
        } else if (fc.receiver_id === "bulkpayment.near" && a.method_name === "approve_list") {
          const id = str(args.list_id);
          const list = id ? bulk(id) : undefined;
          if (!list || list.missing || !list.payments) {
            opaque.push({ dao, proposal_id: p.id, reason: "bulk_list_missing" });
            continue;
          }
          for (const pay of list.payments) {
            if (isPaid(pay.status)) {
              payouts.push({ ...base, path: "bulk", receiver: pay.recipient, token: list.token_id ?? "", amount: pay.amount });
            }
          }
        }
      }
    }
  }
  return { payouts, opaque };
}

export { kindName };
