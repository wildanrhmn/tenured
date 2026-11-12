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
import { MAINNET_FACTORY, NO_CODE_HASH, type ContractMetadata, type Policy } from "./sputnik.js";
import type { CachedDao } from "./crawl.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CACHE = path.join(ROOT, ".cache/mainnet");
export const SNAPSHOT = path.join(ROOT, "data/mainnet/snapshot.json.gz");

export type DaoInfo = {
  dao: string;
  proposals: number;
  code_hash: string | null;
  // Sputnik version if the code is one the factory published, "none" if the
  // account has no contract, null if it runs something else.
  code_version: string | null;
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
  factory_versions: { code_hash: string; version: string; commit_id: string }[];
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

  const meta: ContractMetadata[] = JSON.parse(await readFile(path.join(CACHE, "factory_versions.json"), "utf8"));
  const factory_versions = meta.map(([code_hash, m]) => ({ code_hash, version: m.version.join("."), commit_id: m.commit_id }));
  const versionOf = new Map(factory_versions.map((v) => [v.code_hash, v.version]));

  const snap: Snapshot = {
    version: 1,
    network: "mainnet",
    factory: MAINNET_FACTORY,
    crawled_from: "",
    crawled_to: "",
    factory_versions,
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
      code_hash: d.code_hash ?? null,
      code_version: !d.code_hash ? null : d.code_hash === NO_CODE_HASH ? "none" : (versionOf.get(d.code_hash) ?? null),
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
