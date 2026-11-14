import { describe, expect, it } from "vitest";
import { isAccountId, parseList } from "../src/lib/accounts";
import { defaultForm, installCommands, roleProposalKind, validateInstall, type InstallForm } from "../src/lib/install";

const good = (over: Partial<InstallForm> = {}): InstallForm => ({
  ...defaultForm("mainnet"),
  dao: "fund.sputnik-dao.near",
  lane: "fund-lane.near",
  trusted: "fund.sputnik-dao.near, a.sputnik-dao.near\nb.sputnik-dao.near",
  guardians: "alice.near",
  ...over,
});

describe("account ids", () => {
  it("follows NEAR's rules", () => {
    expect(isAccountId("alice.near")).toBe(true);
    expect(isAccountId("a-b_c.sputnik-dao.near")).toBe(true);
    expect(isAccountId("a".repeat(64))).toBe(true);
    expect(isAccountId("a")).toBe(false);
    expect(isAccountId("Alice.near")).toBe(false);
    expect(isAccountId("alice..near")).toBe(false);
    expect(isAccountId(".near")).toBe(false);
    expect(isAccountId("alice-.near")).toBe(false);
  });

  it("splits lists on commas, spaces and newlines", () => {
    expect(parseList(" a.near,b.near\n\nc.near  a.near ")).toEqual(["a.near", "b.near", "c.near"]);
  });
});

describe("install validation", () => {
  it("builds the init args the lane contract expects", () => {
    const { errors, init } = validateInstall(good());
    expect(errors).toEqual({});
    expect(init).toEqual({
      dao: "fund.sputnik-dao.near",
      factory: "sputnik-dao.near",
      config: expect.objectContaining({
        pay_token: "",
        per_account_cap: "500000000000000000000000000",
        period_budget: "2000000000000000000000000000",
        period_secs: 2_592_000,
        veto_secs: 172_800,
        max_proposal_age_secs: 259_200,
        guardians: ["alice.near"],
      }),
    });
    expect(init!.config.rules.trusted_daos).toHaveLength(3);
    expect(init!.config.rules.exclude_members).toBe(false);
    expect(validateInstall(good({ excludeMembers: true })).init!.config.rules.exclude_members).toBe(true);
    expect(init!.config.rules.tokens[0]).toEqual({ token_id: "", min_amount: "1000000000000000000000000" });
  });

  it("mirrors the contract's validate()", () => {
    expect(validateInstall(good({ cap: "3000" })).errors.cap).toMatch(/can't exceed/);
    expect(validateInstall(good({ periodDays: "0" })).errors.periodDays).toBeTruthy();
    expect(validateInstall(good({ maxAgeDays: "0" })).errors.maxAgeDays).toBeTruthy();
    expect(validateInstall(good({ trusted: "" })).errors.trusted).toMatch(/at least one/);
    const noTokens = good({ floors: defaultForm().floors.map((f) => ({ ...f, enabled: false })) });
    expect(validateInstall(noTokens).errors.floors).toMatch(/at least one token/);
    // The bounds the hardened lane added.
    expect(validateInstall(good({ periodDays: "3651" })).errors.periodDays).toMatch(/10 years/);
    expect(validateInstall(good({ periodDays: "3650" })).errors.periodDays).toBeUndefined();
    expect(validateInstall(good({ vetoHours: "721" })).errors.vetoHours).toMatch(/30 days/);
    expect(validateInstall(good({ vetoHours: "720" })).errors.vetoHours).toBeUndefined();
    expect(validateInstall(good({ maxAgeDays: "366" })).errors.maxAgeDays).toMatch(/a year/);
    expect(validateInstall(good({ minDaos: "0" })).errors.minDaos).toBeTruthy();
    expect(validateInstall(good({ minPayouts: "0" })).errors.minPayouts).toBeTruthy();
  });

  it("catches configs that are valid but could never pay anyone", () => {
    expect(validateInstall(good({ trusted: "a.sputnik-dao.near, evil.near" })).errors.trusted).toMatch(/evil\.near/);
    expect(validateInstall(good({ minDaos: "4" })).errors.minDaos).toMatch(/Only 3 DAOs/);
    expect(validateInstall(good({ minPayouts: "10" })).errors.minPayouts).toMatch(/At most 9/);
    expect(validateInstall(good({ dao: "fund.near" })).errors.dao).toMatch(/Sputnik DAO/);
    expect(validateInstall(good({ network: "testnet" })).errors.dao).toMatch(/sputnikv2\.testnet/);
  });

  it("keeps the veto window inside the DAO's proposal period", () => {
    const week = { proposal_period_ns: String(7 * 86_400 * 1e9), proposal_bond: "100000000000000000000000" };
    expect(validateInstall(good({ vetoHours: "200" }), week).errors.vetoHours).toMatch(/5 minutes before/);
    // 168 h is the whole period; the lane needs 5 minutes of margin.
    expect(validateInstall(good({ vetoHours: "167.95" }), week).errors.vetoHours).toMatch(/5 minutes before/);
    expect(validateInstall(good({ vetoHours: "48" }), week).errors.vetoHours).toBeUndefined();
    expect(validateInstall(good({ vetoHours: "160", maxAgeDays: "1" }), week).warnings.join(" ")).toMatch(/maximum age/);
    expect(validateInstall(good({ guardians: "" })).warnings.join(" ")).toMatch(/No guardians/);
  });

  it("generates the role proposal and CLI commands", () => {
    expect(roleProposalKind("lane.near")).toEqual({
      ChangePolicyAddOrUpdateRole: {
        role: {
          name: "fastlane",
          kind: { Group: ["lane.near"] },
          permissions: ["transfer:VoteApprove"],
          vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
        },
      },
    });
    const { init } = validateInstall(good());
    const cmds = installCommands(init!, "fund-lane.near", "mainnet", "bob.near", { proposal_bond: "100000000000000000000000", proposal_period_ns: null });
    expect(cmds.deploy).toContain("near contract deploy fund-lane.near");
    expect(cmds.deploy).toContain("contracts/target/near/tenured_lane/tenured_lane.wasm");
    expect(cmds.deploy).toContain("network-config mainnet");
    expect(cmds.propose).toContain("attached-deposit '0.1 NEAR'");
    expect(cmds.propose).toContain("sign-as bob.near");
    const json = cmds.propose.match(/json-args '(.*)'/)![1]!;
    expect(JSON.parse(json).proposal.kind.ChangePolicyAddOrUpdateRole.role.name).toBe("fastlane");
  });
});
