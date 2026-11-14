// Runs the simulator off the main thread. The worker only needs the
// payouts of people this DAO has paid: claim discovery never looks at
// anyone else, so the result is identical to running on the whole snapshot.

import { simulate, type Payout, type SimConfig, type SimResult } from "../engine";
import type { SnapshotIndex } from "./snapshot";

export function payoutsFor(idx: SnapshotIndex, dao: string): Payout[] {
  const receivers = new Set<string>();
  for (const [receiver, list] of idx.byReceiver) if (list.some((p) => p.dao === dao)) receivers.add(receiver);
  const out: Payout[] = [];
  for (const r of receivers) out.push(...idx.byReceiver.get(r)!);
  return out;
}

export type SimOutput = { r: SimResult; ms: number };

type Pending = { resolve: (o: SimOutput) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let loadedDao = "";
let membersSent = false;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; r?: SimResult; ms: number; error?: string }>) => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (!p) return;
    if (e.data.r) p.resolve({ r: e.data.r, ms: e.data.ms });
    else p.reject(new Error(e.data.error ?? "simulation failed"));
  };
  return worker;
}

export function runSimulation(idx: SnapshotIndex, cfg: SimConfig): Promise<SimOutput> {
  const w = getWorker();
  if (!w) {
    const t0 = performance.now();
    const r = simulate(idx.snap, cfg);
    return Promise.resolve({ r, ms: performance.now() - t0 });
  }
  if (!membersSent) {
    w.postMessage({ type: "members", daos: idx.snap.daos.map((d) => ({ dao: d.dao, groups: d.groups })) });
    membersSent = true;
  }
  if (loadedDao !== cfg.dao) {
    w.postMessage({ type: "load", payouts: payoutsFor(idx, cfg.dao) });
    loadedDao = cfg.dao;
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "run", id, cfg });
  });
}
