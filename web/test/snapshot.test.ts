import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { simulate, suggestTrusted, defaultRules, units } from "../src/engine";
import { indexSnapshot, isGzip, parseSnapshot } from "../src/lib/snapshot";
import { payoutsFor } from "../src/lib/sim";

const tiny = {
  version: 1,
  network: "mainnet",
  factory: "sputnik-dao.near",
  crawled_from: "2026-11-10T00:00:00Z",
  crawled_to: "2026-11-10T01:00:00Z",
  daos: [{ dao: "a.sputnik-dao.near", proposals: 3, proposal_bond: "1", proposal_period_ns: "1", groups: {} }],
  payouts: [
    { dao: "a.sputnik-dao.near", proposal_id: 1, path: "transfer", receiver: "x.near", token: "", amount: "5", time_ns: "1", proposer: "x.near", votes: 2 },
    { dao: "a.sputnik-dao.near", proposal_id: 2, path: "bounty", receiver: "y.near", token: "", amount: "5", time_ns: "2", proposer: "y.near", votes: 1 },
    { dao: "b.sputnik-dao.near", proposal_id: 1, path: "transfer", receiver: "x.near", token: "usdt.tether-token.near", amount: "5", time_ns: "3", proposer: "z.near", votes: 3 },
  ],
  opaque: [],
};

describe("snapshot loader", () => {
  it("inflates gzip and also accepts bytes a server already inflated", async () => {
    const json = new TextEncoder().encode(JSON.stringify(tiny));
    const gz = new Uint8Array(gzipSync(json));
    expect(isGzip(gz)).toBe(true);
    expect(isGzip(json)).toBe(false);
    expect((await parseSnapshot(gz)).payouts).toHaveLength(3);
    expect((await parseSnapshot(json)).payouts).toHaveLength(3);
  });

  it("rejects files that aren't a version 1 snapshot", async () => {
    await expect(parseSnapshot(new TextEncoder().encode('{"version":2}'))).rejects.toThrow(/version 1/);
  });

  it("indexes DAOs by payout count and transfers by token", () => {
    const idx = indexSnapshot(tiny as never);
    expect(idx.daos.map((d) => [d.dao, d.payouts])).toEqual([
      ["a.sputnik-dao.near", 2],
      ["b.sputnik-dao.near", 1],
    ]);
    expect(idx.daos[0]!.transfersByToken.get("")).toBe(1);
    expect(idx.byReceiver.get("x.near")).toHaveLength(2);
  });

  it("parses the committed mainnet snapshot and simulates on it", async () => {
    const file = path.resolve(import.meta.dirname, "../../data/mainnet/snapshot.json.gz");
    const snap = await parseSnapshot(new Uint8Array(readFileSync(file)));
    const idx = indexSnapshot(snap);
    expect(snap.daos.length).toBeGreaterThan(2000);
    expect(idx.daos.every((d) => d.payouts > 0)).toBe(true);

    const cases = [idx.daos[1]!.dao, idx.daos[7]!.dao].flatMap((dao) => [false, true].map((excludeMembers) => ({ dao, excludeMembers })));
    for (const { dao, excludeMembers } of cases) {
      const cfg = {
        dao,
        rules: defaultRules(suggestTrusted(snap.payouts, dao), { excludeMembers }),
        pay_token: "",
        per_account_cap: units("500", 24),
        period_budget: units("2000", 24),
        period_secs: 30 * 86_400,
      };
      const r = simulate(snap, cfg);
      expect(r.payouts_considered).toBe(r.fast_laned + r.not_qualified + r.blocked_by_cap + r.blocked_by_budget);
      // The worker only gets this DAO's receivers' payouts; the answer must not change.
      const members = snap.daos.map((d) => ({ dao: d.dao, groups: d.groups }));
      expect(simulate({ payouts: payoutsFor(idx, dao), daos: members as typeof snap.daos }, cfg)).toEqual(r);
    }
  });
});
