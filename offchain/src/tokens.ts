// Token table, amount helpers and the default bar. Shared by the CLI, the
// MCP server and the web app, so nothing here touches Node APIs.

import type { Rules } from "./rules.js";

// Common payout tokens on mainnet, so flags can use short names.
export const TOKENS: Record<string, { id: string; decimals: number }> = {
  near: { id: "", decimals: 24 },
  usdc: { id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  "usdc.e": { id: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near", decimals: 6 },
  usdt: { id: "usdt.tether-token.near", decimals: 6 },
  "usdt.e": { id: "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near", decimals: 6 },
  dai: { id: "6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near", decimals: 18 },
};

/// "12.5" in a token with `decimals` → smallest-unit decimal string.
export function units(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  if (!/^[0-9]+$/.test(whole ?? "") || !/^[0-9]*$/.test(frac) || frac.length > decimals) {
    throw new Error(`not an amount: ${human}`);
  }
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

export function human(amount: string, decimals: number): string {
  const v = BigInt(amount);
  const d = 10n ** BigInt(decimals);
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 2);
  return `${v / d}${frac ? "." + frac : ""}`;
}

export type Bar = { minNear?: string; minDaos?: number; minPayouts?: number; excludeMembers?: boolean };

/// Default bar from RULES.md: payouts of at least 1 NEAR or 10 USD-stables,
/// from at least 2 trusted DAOs, at least 3 payouts in total.
export function defaultRules(trusted: string[], bar: Bar = {}): Rules {
  return {
    trusted_daos: trusted,
    tokens: [
      { token_id: TOKENS.near!.id, min_amount: units(bar.minNear ?? "1", 24) },
      ...["usdc", "usdc.e", "usdt", "usdt.e"].map((k) => ({ token_id: TOKENS[k]!.id, min_amount: units("10", 6) })),
      { token_id: TOKENS.dai!.id, min_amount: units("10", 18) },
    ],
    min_distinct_daos: bar.minDaos ?? 2,
    min_payouts: bar.minPayouts ?? 3,
    exclude_members: bar.excludeMembers === true,
  };
}
