// `npm run reproduce`: recomputes every number we publish from the
// committed snapshot, offline, and writes data/mainnet/report.json.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSnapshot, type Snapshot } from "./snapshot.js";
import type { PayoutPath } from "./payouts.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const REPORT = path.join(ROOT, "data/mainnet/report.json");
const YEAR_NS = 365n * 24n * 3600n * 1_000_000_000n;

export function buildReport(s: Snapshot) {
  const withProposals = s.daos.filter((d) => d.proposals > 0).length;
  const payingDaos = new Set(s.payouts.map((p) => p.dao));
  const byPath: Record<PayoutPath, number> = { transfer: 0, bounty: 0, ft_transfer: 0, intents: 0, bulk: 0 };
  for (const p of s.payouts) byPath[p.path]++;
  const opaqueBy: Record<string, number> = {};
  for (const o of s.opaque) opaqueBy[o.reason] = (opaqueBy[o.reason] ?? 0) + 1;

  // How many DAOs paid each receiver (all paths, and claimable Transfer only).
  const daosPerReceiver = new Map<string, Set<string>>();
  const transferDaosPerReceiver = new Map<string, Set<string>>();
  for (const p of s.payouts) {
    (daosPerReceiver.get(p.receiver) ?? daosPerReceiver.set(p.receiver, new Set()).get(p.receiver)!).add(p.dao);
    if (p.path === "transfer") {
      (transferDaosPerReceiver.get(p.receiver) ?? transferDaosPerReceiver.set(p.receiver, new Set()).get(p.receiver)!).add(p.dao);
    }
  }
  const atLeast = (m: Map<string, Set<string>>, n: number) => [...m.values()].filter((v) => v.size >= n).length;

  const latest = s.payouts.reduce((m, p) => (BigInt(p.time_ns) > m ? BigInt(p.time_ns) : m), 0n);
  const lastYear = s.payouts.filter((p) => BigInt(p.time_ns) >= latest - YEAR_NS);

  const groupsOf = new Map(s.daos.map((d) => [d.dao, new Set(Object.values(d.groups).flat())]));
  const toMembers = s.payouts.filter((p) => groupsOf.get(p.dao)?.has(p.receiver)).length;
  const selfFiled = s.payouts.filter((p) => p.proposer === p.receiver).length;
  const total = s.payouts.length;
  const pct = (n: number) => (total ? Math.round((1000 * n) / total) / 10 : 0);

  return {
    snapshot: { crawled_from: s.crawled_from, crawled_to: s.crawled_to, factory: s.factory },
    daos: {
      total: s.daos.length,
      with_any_proposal: withProposals,
      with_any_payout: payingDaos.size,
      crawl_errors: s.daos.filter((d) => d.error).length,
    },
    payouts: {
      total,
      by_path: byPath,
      missed_by_a_transfer_only_crawl_pct: pct(total - byPath.transfer),
      opaque: opaqueBy,
      in_the_last_year: lastYear.length,
      to_members_of_the_paying_dao_pct: pct(toMembers),
      filed_by_the_receiver_pct: pct(selfFiled),
    },
    receivers: {
      total: daosPerReceiver.size,
      paid_by_2_or_more_daos: atLeast(daosPerReceiver, 2),
      paid_by_3_or_more_daos: atLeast(daosPerReceiver, 3),
      claimable_from_2_or_more_daos: atLeast(transferDaosPerReceiver, 2),
    },
  };
}

async function main() {
  const report = buildReport(await loadSnapshot());
  await writeFile(REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${path.relative(ROOT, REPORT)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
