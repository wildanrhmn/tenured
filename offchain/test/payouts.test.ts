import { describe, expect, it } from "vitest";
import { extractPayouts, type BulkList } from "../src/payouts.js";
import type { Proposal } from "../src/sputnik.js";

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64");
let nextId = 0;
const prop = (kind: Proposal["kind"], status: Proposal["status"] = "Approved"): Proposal => ({
  id: nextId++,
  proposer: "x.near",
  description: "",
  kind,
  status,
  vote_counts: {},
  votes: {},
  submission_time: "1700000000000000000",
});
const call = (receiver_id: string, method_name: string, args: object) => ({
  FunctionCall: { receiver_id, actions: [{ method_name, args: b64(args), deposit: "1", gas: "30000000000000" }] },
});

describe("extractPayouts", () => {
  it("reads every payout path and skips what isn't pay", () => {
    nextId = 0;
    const proposals: Proposal[] = [
      prop({ Transfer: { token_id: "", receiver_id: "a.near", amount: "5" } }),
      prop({ Transfer: { token_id: "", receiver_id: "rejected.near", amount: "5" } }, "Rejected"),
      prop({ Transfer: { token_id: "", receiver_id: "failed.near", amount: "5" } }, "Failed"),
      prop({ AddBounty: { bounty: { description: "", token: "usdt.tether-token.near", amount: "100", times: 1, max_deadline: "0" } } }),
      prop({ AddBounty: { bounty: { description: "", token: "", amount: "7", times: 1, max_deadline: "0" } } }, "Rejected"),
      prop({ AddBounty: { bounty: { description: "", token: "", amount: "9", times: 1, max_deadline: "0" } } }),
      prop({ BountyDone: { bounty_id: 1, receiver_id: "hunter.near" } }),
      prop(call("usdt.tether-token.near", "ft_transfer", { receiver_id: "b.near", amount: "20" })),
      prop(call("wrap.near", "ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: "20", msg: "" })),
      prop(call("intents.near", "mt_transfer", { receiver_id: "c.near", token_id: "nep141:usdc.near", amount: "30" })),
      prop(call("v1.signer", "sign", { request: {} })),
      prop(call("bulkpayment.near", "approve_list", { list_id: "L1" })),
      prop(call("bulkpayment.near", "approve_list", { list_id: "GONE" })),
    ];
    const lists: Record<string, BulkList> = {
      L1: {
        token_id: "",
        payments: [
          { recipient: "d.near", amount: "40", status: { Paid: { block_height: 1 } } },
          { recipient: "pending.near", amount: "40", status: "Pending" },
        ],
      },
      GONE: { missing: true },
    };
    const { payouts, opaque } = extractPayouts("dao.sputnik-dao.near", proposals, (id) => lists[id]);

    expect(payouts.map((p) => [p.path, p.receiver, p.token, p.amount])).toEqual([
      ["transfer", "a.near", "", "5"],
      // bounty 1 is the second *approved* AddBounty (the rejected one never got an id)
      ["bounty", "hunter.near", "", "9"],
      ["ft_transfer", "b.near", "usdt.tether-token.near", "20"],
      ["intents", "c.near", "nep141:usdc.near", "30"],
      ["bulk", "d.near", "", "40"],
    ]);
    expect(opaque.map((o) => o.reason)).toEqual(["chain_signature", "bulk_list_missing"]);
  });
});
