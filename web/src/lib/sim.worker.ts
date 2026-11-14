// Simulator worker: holds one DAO's relevant payouts, plus every DAO's
// member list for the exclude_members rule, and replays configs.
import { simulate, type DaoInfo, type Payout, type SimConfig } from "../engine";

let payouts: Payout[] = [];
let daos: Pick<DaoInfo, "dao" | "groups">[] = [];

type Msg =
  | { type: "members"; daos: Pick<DaoInfo, "dao" | "groups">[] }
  | { type: "load"; payouts: Payout[] }
  | { type: "run"; id: number; cfg: SimConfig };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === "members") {
    daos = m.daos;
    return;
  }
  if (m.type === "load") {
    payouts = m.payouts;
    return;
  }
  const t0 = performance.now();
  try {
    const r = simulate({ payouts, daos: daos as DaoInfo[] }, m.cfg);
    self.postMessage({ id: m.id, r, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id: m.id, error: (err as Error).message, ms: 0 });
  }
};
