import { TOKENS, human, units } from "../engine";

const int = new Intl.NumberFormat("en-US");

export const fmtInt = (n: number) => int.format(n);

export const fmtPct = (n: number, digits = 1) => `${n.toFixed(digits)}%`;

/** Smallest units → "1,234.5": thousands separators, rounded to two decimals. */
export function fmtAmount(amount: string, decimals: number): string {
  let h: string;
  if (decimals < 2) h = human(amount, decimals);
  else {
    const scale = 10n ** BigInt(decimals - 2);
    const cents = (BigInt(amount) + scale / 2n) / scale;
    h = human(cents.toString(), 2);
  }
  const [whole, frac] = h.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

export type TokenKey = keyof typeof TOKENS & string;

export const TOKEN_LABELS: Record<string, string> = {
  near: "NEAR",
  usdc: "USDC",
  "usdc.e": "USDC.e (bridged)",
  usdt: "USDT",
  "usdt.e": "USDT.e (bridged)",
  dai: "DAI",
};

export function tokenSymbol(key: string): string {
  return (TOKEN_LABELS[key] ?? key).split(" ")[0]!;
}

export function tokenKeyById(id: string): string | undefined {
  return Object.keys(TOKENS).find((k) => TOKENS[k]!.id === id);
}

/** Implicit accounts are 64 hex characters; show the ends. */
export function shortAccount(a: string): string {
  return /^[0-9a-f]{64}$/.test(a) ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

/** "trackrecord-alpha.sputnikv2.testnet" → ["trackrecord-alpha", ".sputnikv2.testnet"] */
export function splitDao(dao: string): [string, string] {
  const i = dao.indexOf(".");
  return i < 0 ? [dao, ""] : [dao.slice(0, i), dao.slice(i)];
}

export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Parses a human amount, returning null instead of throwing. */
export function tryUnits(value: string, decimals: number): string | null {
  try {
    return units(value.trim(), decimals);
  } catch {
    return null;
  }
}
