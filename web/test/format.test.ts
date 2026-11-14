import { describe, expect, it } from "vitest";
import { fmtAmount, fmtDuration, shortAccount, tokenKeyById, tryUnits } from "../src/lib/format";
import { demoCommands, expiresInSecs, nsToMs, statusView, vetoRemainingSecs, type LaneRequest } from "../src/lib/lane";

describe("amounts", () => {
  it("groups thousands and keeps two decimals", () => {
    expect(fmtAmount("1234567500000", 6)).toBe("1,234,567.5");
    expect(fmtAmount("499999999999999991611392", 24)).toBe("0.5");
    expect(fmtAmount("1994999", 6)).toBe("1.99");
    expect(fmtAmount("1995000", 6)).toBe("2");
    expect(fmtAmount("0", 24)).toBe("0");
  });

  it("parses user input without throwing", () => {
    expect(tryUnits(" 12.5 ", 6)).toBe("12500000");
    expect(tryUnits("1e3", 6)).toBeNull();
    expect(tryUnits("", 6)).toBeNull();
  });

  it("finds token keys and shortens implicit accounts", () => {
    expect(tokenKeyById("")).toBe("near");
    expect(tokenKeyById("usdt.tether-token.near")).toBe("usdt");
    expect(shortAccount("a".repeat(64))).toBe("aaaaaaaa…aaaaaa");
    expect(shortAccount("alice.near")).toBe("alice.near");
  });

  it("formats countdowns", () => {
    expect(fmtDuration(42)).toBe("42s");
    expect(fmtDuration(605)).toBe("10m 05s");
    expect(fmtDuration(3 * 86_400 + 7200)).toBe("3d 2h");
  });
});

describe("live lane", () => {
  const req = (status: LaneRequest["status"], at: number, expires = 0): LaneRequest => ({
    id: 0,
    account_id: "dev.testnet",
    proposal_id: 1,
    amount: "1",
    nonce: 1,
    period: 1,
    registered_at_ns: 0,
    executable_at_ns: at,
    expires_at_ns: expires,
    approving_at_ns: 0,
    distinct_daos: 2,
    payouts: 3,
    status,
  });

  it("reads statuses and veto countdowns", () => {
    expect(statusView({ Refused: { reason: "track record too short" } })).toEqual({ name: "Refused", detail: "track record too short" });
    expect(statusView({ Vetoed: { by: "g.testnet" } }).name).toBe("Vetoed");
    expect(nsToMs(1794301229196231906)).toBe(1794301229196);
    expect(vetoRemainingSecs(req("Waiting", 10_000 * 1e6), 4_000)).toBe(6);
    expect(vetoRemainingSecs(req("Waiting", 10_000 * 1e6), 20_000)).toBe(0);
    expect(vetoRemainingSecs(req("Approved", 10_000 * 1e6), 4_000)).toBeNull();
  });

  it("explains Voted and shows when the proposal expires", () => {
    expect(statusView("Voted").name).toBe("Voted");
    expect(statusView("Voted").detail).toMatch(/stays counted/);
    expect(expiresInSecs(req("Voted", 0, 70_000 * 1e6), 10_000)).toBe(60);
    expect(expiresInSecs(req("Waiting", 0, 0), 10_000)).toBeNull();
    expect(expiresInSecs(req("Approved", 0, 70_000 * 1e6), 10_000)).toBeNull();
  });

  it("writes register commands whose nonce the shell fills in", () => {
    const c = demoCommands({
      amountYocto: "500000000000000000000000",
      proposalId: "4",
      requestId: "2",
      bond: "1000000000000000000000000",
      storageDeposit: "10000000000000000000000",
    });
    expect(c.register).toContain(`"nonce":'$(date +%s)'`);
    expect(c.register).toContain(`"proposal_id":4`);
    expect(c.veto).toContain(`'{"id":2}'`);
    expect(c.veto).toContain("sign-as trackrecord-guardian.testnet");
    expect(c.register).toContain("attached-deposit '0.01 NEAR'");
    expect(c.file).toContain("attached-deposit '1 NEAR'");
    expect(c.recheck).toContain("trackrecord-lane.testnet recheck");
  });
});
