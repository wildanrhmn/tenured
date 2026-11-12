// Crawls every Sputnik DAO on mainnet into .cache/mainnet/.
//
//   npm run crawl                 # resume: only DAOs not cached yet
//   npm run crawl -- --refresh    # re-read everything
//
// Every call is a free view call. A cached file is written per DAO, so an
// interrupted run picks up where it stopped. `npm run snapshot` then turns
// the cache into the committed snapshot.

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { MAINNET_RPCS, RpcPool, ViewError } from "./rpc.js";
import { MAINNET_FACTORY, type ContractMetadata, type Policy, type Proposal } from "./sputnik.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const CACHE = path.join(ROOT, ".cache/mainnet");
const DAO_DIR = path.join(CACHE, "daos");
const BULK_DIR = path.join(CACHE, "bulk");
export const BULK_CONTRACT = "bulkpayment.near";

export type CachedDao = {
  dao: string;
  crawled_at: string;
  code_hash?: string;
  last_proposal_id: number;
  proposals: Proposal[];
  policy: Policy | null;
  error?: string;
  // "contract": the account no longer answers like Sputnik (code removed or
  // replaced); retrying won't help. "transport": RPC trouble; retried.
  error_kind?: "contract" | "transport";
};

const PAGE = 100;
const CONCURRENCY = 4;

async function crawlDao(rpc: RpcPool, dao: string): Promise<CachedDao> {
  const out: CachedDao = { dao, crawled_at: new Date().toISOString(), last_proposal_id: 0, proposals: [], policy: null };
  try {
    out.code_hash = await rpc.codeHash(dao);
    out.last_proposal_id = (await rpc.view<number>(dao, "get_last_proposal_id")) ?? 0;
    for (let from = 0; from < out.last_proposal_id; from += PAGE) {
      const page = await rpc.view<Proposal[]>(dao, "get_proposals", { from_index: from, limit: PAGE });
      out.proposals.push(...page);
    }
    if (out.last_proposal_id > 0) out.policy = await rpc.view<Policy>(dao, "get_policy");
  } catch (e) {
    out.error = (e as Error).message;
    out.error_kind = e instanceof ViewError ? e.kind : "transport";
  }
  return out;
}

// Trezu bulk payments: the DAO approves `approve_list(list_id)` on
// bulkpayment.near and the recipients only live in that contract.
function bulkListIds(dao: CachedDao): string[] {
  const ids: string[] = [];
  for (const p of dao.proposals) {
    if (typeof p.kind !== "object" || !("FunctionCall" in p.kind)) continue;
    const fc = (p.kind as { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string }[] } }).FunctionCall;
    if (fc.receiver_id !== BULK_CONTRACT) continue;
    for (const a of fc.actions) {
      if (a.method_name !== "approve_list") continue;
      try {
        const args = JSON.parse(Buffer.from(a.args, "base64").toString("utf8"));
        if (typeof args.list_id === "string") ids.push(args.list_id);
      } catch {
        // malformed args: the proposal would have failed anyway
      }
    }
  }
  return ids;
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]!, idx);
      }
    }),
  );
}

async function main() {
  const refresh = process.argv.includes("--refresh");
  await mkdir(DAO_DIR, { recursive: true });
  await mkdir(BULK_DIR, { recursive: true });
  const rpc = new RpcPool(MAINNET_RPCS);

  const daos = await rpc.view<string[]>(MAINNET_FACTORY, "get_dao_list");
  await writeFile(path.join(CACHE, "dao_list.json"), JSON.stringify(daos));
  const versions = await rpc.view<ContractMetadata[]>(MAINNET_FACTORY, "get_contracts_metadata");
  await writeFile(path.join(CACHE, "factory_versions.json"), JSON.stringify(versions));
  const todo = [];
  for (const dao of daos) {
    const file = path.join(DAO_DIR, `${dao}.json`);
    if (!refresh && existsSync(file)) {
      const cached: CachedDao = JSON.parse(await readFile(file, "utf8"));
      // Contract-level failures are permanent (the account no longer runs
      // Sputnik); only transport failures are worth another try.
      if (!cached.error || cached.error_kind === "contract") continue;
    }
    todo.push(dao);
  }
  console.log(`${daos.length} DAOs on ${MAINNET_FACTORY}; ${todo.length} to crawl`);

  const started = Date.now();
  let done = 0;
  let failed = 0;
  await pool(todo, CONCURRENCY, async (dao) => {
    const res = await crawlDao(rpc, dao);
    if (res.error) failed++;
    await writeFile(path.join(DAO_DIR, `${dao}.json`), JSON.stringify(res));
    if (++done % 50 === 0 || done === todo.length) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`  ${done}/${todo.length} DAOs (${failed} failed) after ${mins} min`);
    }
  });

  // Code hashes for DAOs cached before we recorded them: one cheap
  // view_account each, no need to re-read their proposals.
  const missingHash: string[] = [];
  for (const f of await readdir(DAO_DIR)) {
    const cached: CachedDao = JSON.parse(await readFile(path.join(DAO_DIR, f), "utf8"));
    if (!cached.code_hash) missingHash.push(f);
  }
  if (missingHash.length) console.log(`${missingHash.length} DAOs need a code hash`);
  await pool(missingHash, CONCURRENCY, async (f) => {
    const file = path.join(DAO_DIR, f);
    const cached: CachedDao = JSON.parse(await readFile(file, "utf8"));
    try {
      cached.code_hash = await rpc.codeHash(cached.dao);
      await writeFile(file, JSON.stringify(cached));
    } catch {
      // left for the next run
    }
  });

  // Resolve Trezu bulk payment lists referenced by approved proposals.
  const listIds = new Set<string>();
  for (const f of await readdir(DAO_DIR)) {
    const cached: CachedDao = JSON.parse(await readFile(path.join(DAO_DIR, f), "utf8"));
    for (const id of bulkListIds(cached)) listIds.add(id);
  }
  const lists = [...listIds].filter((id) => refresh || !existsSync(path.join(BULK_DIR, `${id}.json`)));
  console.log(`${listIds.size} bulk payment lists referenced; ${lists.length} to fetch`);
  await pool(lists, CONCURRENCY, async (id) => {
    try {
      const list = await rpc.view(BULK_CONTRACT, "view_list", { list_id: id });
      await writeFile(path.join(BULK_DIR, `${id}.json`), JSON.stringify(list));
    } catch (e) {
      // Lists are removed once fully paid out on some versions; record the miss.
      const kind = e instanceof ViewError ? e.kind : "transport";
      await writeFile(path.join(BULK_DIR, `${id}.json`), JSON.stringify({ missing: true, kind }));
    }
  });
  let gone = 0;
  let retry = 0;
  for (const f of await readdir(DAO_DIR)) {
    const cached: CachedDao = JSON.parse(await readFile(path.join(DAO_DIR, f), "utf8"));
    if (cached.error) cached.error_kind === "contract" ? gone++ : retry++;
  }
  console.log(
    `crawl finished in ${((Date.now() - started) / 60000).toFixed(1)} min: ` +
      `${gone} DAOs no longer run Sputnik, ${retry} failed on RPC${retry ? " (rerun to retry them)" : ""}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
