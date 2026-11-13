import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkClaim, checkProposal, isFactoryDao, staticChecks, summarize, type Claim, type Reject, type Rules, type Summary } from "../src/rules.js";

// The same file the Rust rules crate tests against.
const fixtures = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../fixtures/claims.json"), "utf8")) as {
  factory: string;
  rules: Rules;
  static_cases: { name: string; claims: Claim[]; expect: (Reject | null)[] }[];
  proposal_cases: { name: string; claimant: string; proposal: unknown; expect: Reject | null }[];
  member_proposal: unknown;
  member_cases: { name: string; claimant: string; exclude_members: boolean; policy: unknown; expect: Reject | null }[];
  summary_cases: { name: string; valid: Claim[]; expect: Summary }[];
};

describe("matches the Rust rules on fixtures/claims.json", () => {
  for (const c of fixtures.static_cases) {
    it(`static: ${c.name}`, () => expect(staticChecks(c.claims, fixtures.rules, fixtures.factory)).toEqual(c.expect));
  }
  for (const c of fixtures.proposal_cases) {
    it(`proposal: ${c.name}`, () => expect(checkProposal(c.proposal, c.claimant, fixtures.rules)).toBe(c.expect));
  }
  for (const c of fixtures.member_cases) {
    it(`member: ${c.name}`, () =>
      expect(checkClaim(fixtures.member_proposal, c.policy, c.claimant, { ...fixtures.rules, exclude_members: c.exclude_members })).toBe(c.expect));
  }
  for (const c of fixtures.summary_cases) {
    it(`summary: ${c.name}`, () => expect(summarize(c.valid, fixtures.rules)).toEqual(c.expect));
  }
});

describe("factory names", () => {
  it("accepts only direct sub-accounts of the factory", () => {
    expect(isFactoryDao("marketing.sputnik-dao.near", "sputnik-dao.near")).toBe(true);
    expect(isFactoryDao("sputnik-dao.near", "sputnik-dao.near")).toBe(false);
    expect(isFactoryDao("a.b.sputnik-dao.near", "sputnik-dao.near")).toBe(false);
    expect(isFactoryDao("evilsputnik-dao.near", "sputnik-dao.near")).toBe(false);
  });
});
