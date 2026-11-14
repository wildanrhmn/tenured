// NEAR account id rules (nomicon: Data Structures › Account).
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
}

/** Splits a free-text list on commas, spaces and newlines; trims and dedupes. */
export function parseList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export const nearblocks = (network: "mainnet" | "testnet", account: string) =>
  `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/address/${account}`;
