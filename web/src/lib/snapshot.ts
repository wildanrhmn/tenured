// Loads data/mainnet/snapshot.json.gz in the browser, once.
//
// Static hosts disagree about .gz files: some send the raw gzip bytes, some
// add Content-Encoding and the browser has already inflated them. The gzip
// magic number tells the two apart.

import type { DaoInfo, Payout, Snapshot } from "../engine";

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function parseSnapshot(bytes: Uint8Array): Promise<Snapshot> {
  const text = isGzip(bytes) ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  const snap = JSON.parse(text) as Snapshot;
  if (snap?.version !== 1 || !Array.isArray(snap.daos) || !Array.isArray(snap.payouts)) {
    throw new Error("The snapshot file isn't in the expected format (version 1).");
  }
  return snap;
}

export type DaoRow = {
  dao: string;
  /** Every payout path the crawler reads. */
  payouts: number;
  /** Direct Transfer payouts by token id ("" is NEAR). Only these can be fast-laned. */
  transfersByToken: Map<string, number>;
};

export type SnapshotIndex = {
  snap: Snapshot;
  /** DAOs with at least one payout, most payouts first. */
  daos: DaoRow[];
  info: Map<string, DaoInfo>;
  byReceiver: Map<string, Payout[]>;
};

export function indexSnapshot(snap: Snapshot): SnapshotIndex {
  const rows = new Map<string, DaoRow>();
  const byReceiver = new Map<string, Payout[]>();
  for (const p of snap.payouts) {
    const row = rows.get(p.dao) ?? rows.set(p.dao, { dao: p.dao, payouts: 0, transfersByToken: new Map() }).get(p.dao)!;
    row.payouts++;
    if (p.path === "transfer") row.transfersByToken.set(p.token, (row.transfersByToken.get(p.token) ?? 0) + 1);
    (byReceiver.get(p.receiver) ?? byReceiver.set(p.receiver, []).get(p.receiver)!).push(p);
  }
  const daos = [...rows.values()].sort((a, b) => b.payouts - a.payouts || a.dao.localeCompare(b.dao));
  return { snap, daos, info: new Map(snap.daos.map((d) => [d.dao, d])), byReceiver };
}

let cached: Promise<SnapshotIndex> | null = null;

export function snapshotUrl(): string {
  return `${import.meta.env.BASE_URL}data/snapshot.json.gz`;
}

/** Fetches, inflates, parses and indexes the snapshot. Shared by every page. */
export function loadSnapshot(): Promise<SnapshotIndex> {
  cached ??= (async () => {
    const res = await fetch(snapshotUrl());
    if (!res.ok) throw new Error(`Couldn't download the snapshot (HTTP ${res.status}).`);
    return indexSnapshot(await parseSnapshot(new Uint8Array(await res.arrayBuffer())));
  })().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}
