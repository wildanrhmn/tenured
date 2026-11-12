// Builds data/mainnet/snapshot.json.gz from the crawl cache.
//
//   npm run crawl && npm run snapshot
//
// The snapshot is what the simulator, claim discovery and `npm run
// reproduce` read, so judges can rerun everything offline.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { extractPayouts, type BulkList, type Opaque, type Payout } from "./payouts.js";
import { MAINNET_FACTORY, type Policy } from "./sputnik.js";
import type { CachedDao } from "./crawl.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CACHE = path.join(ROOT, ".cache/mainnet");
export const SNAPSHOT = path.join(ROOT, "data/mainnet/snapshot.json.gz");

export type DaoInfo = {
  dao: string;
  proposals: number;
  proposal_bond: string | null;
  proposal_period_ns: string | null;
  // Members of Group roles, by role name. Used to spot self-dealing.
  groups: Record<string, string[]>;
  error?: string;
};

export type Snapshot = {
  version: 1;
  network: "mainnet";
  factory: string;
  crawled_from: string;
  crawled_to: string;
  daos: DaoInfo[];
  payouts: Payout[];
  opaque: Opaque[];
};

function groups(policy: Policy | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of policy?.roles ?? []) {
    if (typeof r.kind === "object" && "Group" in r.kind) out[r.name] = [...r.kind.Group].sort();
  }
  return out;
}

export async function loadSnapshot(file = SNAPSHOT): Promise<Snapshot> {
  return JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
}

async function main() {
  const files = (await readdir(path.join(CACHE, "daos"))).sort();
  const bulkCache = new Map<string, BulkList>();
  // Bulk lookups happen inside a sync callback, so these small files are read synchronously.
  const bulk = (id: string) => {
    if (!bulkCache.has(id)) {
      const f = path.join(CACHE, "bulk", `${id}.json`);
      bulkCache.set(id, existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { missing: true });
    }
    return bulkCache.get(id);
  };

  const snap: Snapshot = {
    version: 1,
    network: "mainnet",
    factory: MAINNET_FACTORY,
    crawled_from: "",
    crawled_to: "",
    daos: [],
    payouts: [],
    opaque: [],
  };
  const times: string[] = [];
  for (const f of files) {
    const d: CachedDao = JSON.parse(await readFile(path.join(CACHE, "daos", f), "utf8"));
    times.push(d.crawled_at);
    snap.daos.push({
      dao: d.dao,
      proposals: d.last_proposal_id,
      proposal_bond: d.policy?.proposal_bond ?? null,
      proposal_period_ns: d.policy?.proposal_period ?? null,
      groups: groups(d.policy),
      ...(d.error ? { error: d.error } : {}),
    });
    const { payouts, opaque } = extractPayouts(d.dao, d.proposals, bulk);
    snap.payouts.push(...payouts);
    snap.opaque.push(...opaque);
  }
  times.sort();
  snap.crawled_from = times[0] ?? "";
  snap.crawled_to = times.at(-1) ?? "";

  await mkdir(path.dirname(SNAPSHOT), { recursive: true });
  const gz = gzipSync(JSON.stringify(snap), { level: 9 });
  await writeFile(SNAPSHOT, gz);
  console.log(
    `snapshot: ${snap.daos.length} DAOs, ${snap.payouts.length} payouts, ${snap.opaque.length} opaque, ` +
      `${(gz.length / 1024 / 1024).toFixed(2)} MB -> ${path.relative(ROOT, SNAPSHOT)}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
