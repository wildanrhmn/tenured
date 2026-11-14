import { useEffect, useMemo, useState } from "react";
import { DaoPicker } from "../components/DaoPicker";
import { PeriodChart } from "../components/PeriodChart";
import { DaoName, ExcludeMembers, Field, Gate, PageHead, Row, TextInput, TrustedList } from "../components/ui";
import { TOKENS, defaultRules, suggestTrusted, type SimConfig, type SimResult } from "../engine";
import { TOKEN_LABELS, fmtAmount, fmtInt, fmtPct, tokenKeyById, tokenSymbol, tryUnits } from "../lib/format";
import { href } from "../lib/router";
import { runSimulation } from "../lib/sim";
import type { SnapshotIndex } from "../lib/snapshot";
import { useSnapshot } from "../lib/useSnapshot";

export function Simulate({ initialDao }: { initialDao: string }) {
  const snap = useSnapshot();
  return (
    <div className="page">
      <PageHead eyebrow="Simulator" title="Try it on your DAO." dim="Replay its real history.">
        <p>
          Replay a DAO's real payout history as if the fast lane had been installed, using only the record each
          contributor could have presented at the time. Results are totals for the DAO; no one is listed.
        </p>
      </PageHead>
      <Gate load={snap} what="Loading 2,114 mainnet DAOs from the snapshot">
        {(idx) => <SimulateBody idx={idx} initialDao={initialDao} />}
      </Gate>
    </div>
  );
}

function bestToken(idx: SnapshotIndex, dao: string): string {
  const row = idx.daos.find((d) => d.dao === dao);
  let best = "near";
  let n = -1;
  for (const [id, count] of row?.transfersByToken ?? []) {
    const key = tokenKeyById(id);
    if (key && count > n) (best = key), (n = count);
  }
  return best;
}

const whole = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

function SimulateBody({ idx, initialDao }: { idx: SnapshotIndex; initialDao: string }) {
  const start = idx.daos.some((d) => d.dao === initialDao) ? initialDao : idx.daos[0]!.dao;
  const [dao, setDao] = useState(start);
  const [token, setToken] = useState(() => bestToken(idx, start));
  const [trusted, setTrusted] = useState(() => suggestTrusted(idx.snap.payouts, start));
  const [cap, setCap] = useState("500");
  const [budget, setBudget] = useState("2000");
  const [periodDays, setPeriodDays] = useState("30");
  const [minDaos, setMinDaos] = useState("2");
  const [minPayouts, setMinPayouts] = useState("3");
  const [minNear, setMinNear] = useState("1");
  const [exclude, setExclude] = useState(false);

  const pickDao = (d: string) => {
    setDao(d);
    setToken(bestToken(idx, d));
    setTrusted(suggestTrusted(idx.snap.payouts, d));
    history.replaceState(null, "", href("simulate", d));
  };

  const t = TOKENS[token]!;
  const sym = tokenSymbol(token);
  const errors: Record<string, string> = {};
  const capU = tryUnits(cap, t.decimals);
  const budgetU = tryUnits(budget, t.decimals);
  if (capU === null) errors.cap = "Enter an amount, like 500.";
  if (budgetU === null) errors.budget = "Enter an amount, like 2000.";
  const days = Number(periodDays);
  if (!/^\d+(\.\d+)?$/.test(periodDays.trim()) || !(days > 0)) errors.periodDays = "A positive number of days.";
  const md = whole(minDaos);
  const mp = whole(minPayouts);
  if (md === null || md < 1 || md > 9) errors.minDaos = "A whole number from 1 to 9.";
  if (mp === null || mp < 1 || mp > 9) errors.minPayouts = "A whole number from 1 to 9.";
  if (tryUnits(minNear, 24) === null) errors.minNear = "Enter an amount, like 1.";
  if (trusted.length === 0) errors.trusted = "Trust at least one DAO.";

  const cfg: SimConfig | null =
    Object.keys(errors).length === 0
      ? {
          dao,
          rules: defaultRules(trusted, { minNear: minNear.trim(), minDaos: md!, minPayouts: mp!, excludeMembers: exclude }),
          pay_token: t.id,
          per_account_cap: capU!,
          period_budget: budgetU!,
          period_secs: Math.round(days * 86_400),
        }
      : null;
  const key = cfg ? JSON.stringify(cfg) : "";

  const [result, setResult] = useState<{ key: string; r: SimResult; ms: number } | null>(null);
  useEffect(() => {
    if (!cfg) return;
    let live = true;
    const timer = setTimeout(() => {
      runSimulation(idx, cfg).then(
        (o) => live && setResult({ key, ...o }),
        () => live && setResult(null),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The key captures every input of cfg.
  }, [key]);

  const trustedSet = useMemo(() => new Set(trusted), [trusted]);
  const stale = !result || result.key !== key;
  const daoRow = idx.daos.find((d) => d.dao === dao);

  return (
    <div className="workbench">
      <form className="panel config" onSubmit={(e) => e.preventDefault()} aria-label="Simulation settings">
        <Field id="sim-dao" label="DAO" hint={daoRow ? `${fmtInt(daoRow.payouts)} payouts in the snapshot` : "Not in the snapshot"}>
          <DaoPicker id="sim-dao" daos={idx.daos} value={dao} onPick={pickDao} />
        </Field>

        <fieldset>
          <legend>What the lane pays</legend>
          <Field id="sim-token" label="Pay token">
            <select id="sim-token" value={token} onChange={(e) => setToken(e.target.value)}>
              {Object.keys(TOKENS).map((k) => (
                <option key={k} value={k}>
                  {TOKEN_LABELS[k]} · {fmtInt(daoRow?.transfersByToken.get(TOKENS[k]!.id) ?? 0)} transfers
                </option>
              ))}
            </select>
          </Field>
          <div className="pair">
            <Field id="sim-cap" label={`Per-account cap (${sym})`} error={errors.cap} hint="Per period">
              <TextInput id="sim-cap" inputMode="decimal" value={cap} onChange={setCap} invalid={!!errors.cap} />
            </Field>
            <Field id="sim-budget" label={`Period budget (${sym})`} error={errors.budget} hint="All accounts">
              <TextInput id="sim-budget" inputMode="decimal" value={budget} onChange={setBudget} invalid={!!errors.budget} />
            </Field>
          </div>
          <Field id="sim-period" label="Period length (days)" error={errors.periodDays}>
            <TextInput id="sim-period" inputMode="decimal" value={periodDays} onChange={setPeriodDays} invalid={!!errors.periodDays} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>What counts as a track record</legend>
          <div className="pair">
            <Field id="sim-mindaos" label="Min. DAOs" error={errors.minDaos} hint="Distinct payers">
              <TextInput id="sim-mindaos" inputMode="numeric" value={minDaos} onChange={setMinDaos} invalid={!!errors.minDaos} />
            </Field>
            <Field id="sim-minpay" label="Min. payouts" error={errors.minPayouts} hint="In total">
              <TextInput id="sim-minpay" inputMode="numeric" value={minPayouts} onChange={setMinPayouts} invalid={!!errors.minPayouts} />
            </Field>
          </div>
          <Field id="sim-minnear" label="Smallest NEAR payout that counts" error={errors.minNear} hint="Stablecoin payouts count from 10">
            <TextInput id="sim-minnear" inputMode="decimal" value={minNear} onChange={setMinNear} invalid={!!errors.minNear} />
          </Field>
          <ExcludeMembers id="sim-exclude" checked={exclude} onChange={setExclude} />
        </fieldset>

        <fieldset>
          <legend>Trusted DAOs</legend>
          <p className="field-hint">
            Prefilled with this DAO and the DAOs that paid the same people most often. Only payouts from these count.
          </p>
          {errors.trusted && (
            <p className="field-error" role="alert">
              {errors.trusted}
            </p>
          )}
          <TrustedList daos={trusted} locked={dao} onRemove={(d) => setTrusted(trusted.filter((x) => x !== d))} />
          <Field id="sim-add" label="Add a DAO">
            <DaoPicker
              id="sim-add"
              daos={idx.daos}
              exclude={trustedSet}
              clearOnPick
              placeholder="Search to add"
              onPick={(d) => !trustedSet.has(d) && setTrusted([...trusted, d])}
            />
          </Field>
          <button type="button" className="btn-quiet" onClick={() => setTrusted(suggestTrusted(idx.snap.payouts, dao))}>
            Reset to suggested
          </button>
        </fieldset>
      </form>

      <section className="results" aria-live="polite" aria-busy={stale}>
        {!cfg ? (
          <div className="state">Fix the highlighted settings to run the simulation.</div>
        ) : !result ? (
          <div className="state" role="status">
            <span className="spinner" aria-hidden="true" />
            Replaying history
          </div>
        ) : (
          <Results r={result.r} ms={result.ms} stale={stale} token={token} budget={budget} />
        )}
      </section>
    </div>
  );
}

function Results({ r, ms, stale, token, budget }: { r: SimResult; ms: number; stale: boolean; token: string; budget: string }) {
  const t = TOKENS[token]!;
  const sym = tokenSymbol(token);
  const pct = r.payouts_considered ? (100 * r.fast_laned) / r.payouts_considered : 0;
  const maxPct = (() => {
    const b = tryUnits(budget, t.decimals);
    return b && b !== "0" ? Number((BigInt(r.max_period_amount) * 1000n) / BigInt(b)) / 10 : 0;
  })();

  if (r.payouts_considered === 0) {
    return (
      <div className={`result-body${stale ? " is-stale" : ""}`}>
        <h2 className="result-title">
          No direct {sym} payouts in <DaoName dao={r.dao} />
        </h2>
        <p className="muted">
          The lane approves Transfer proposals in one token. Pick a token this DAO has paid in; the token menu shows how
          many transfers each has.
        </p>
      </div>
    );
  }

  return (
    <div className={`result-body${stale ? " is-stale" : ""}`}>
      <p className="result-kicker">
        <DaoName dao={r.dao} />
      </p>
      <h2 className="result-title">
        <span className="big">{fmtPct(pct, 0)}</span> of its {fmtInt(r.payouts_considered)} {sym} payouts would have
        skipped a council vote.
      </h2>

      <dl className="ledger">
        <Row label="Payouts considered" value={fmtInt(r.payouts_considered)} note={`approved Transfers in ${sym}`} />
        <Row tone="accent" label="Would have skipped a vote" value={fmtInt(r.fast_laned)} note={`${fmtAmount(r.amount_fast_laned, t.decimals)} ${sym} in total`} />
        <Row tone="accent" label="Council votes saved" value={fmtInt(r.votes_saved)} />
        <Row label="Not enough track record" value={fmtInt(r.not_qualified)} note="went to a vote as usual" />
        <Row
          tone="veto"
          label="Stopped by cap / budget"
          value={`${fmtInt(r.blocked_by_cap)} / ${fmtInt(r.blocked_by_budget)}`}
          note="qualified, but over a limit"
        />
        <Row
          label="Most moved in one period"
          value={`${fmtAmount(r.max_period_amount, t.decimals)} ${sym}`}
          note={`${fmtPct(maxPct, 0)} of the ${budget} ${sym} budget`}
        />
      </dl>

      <h3 className="sub">Per period</h3>
      <PeriodChart rows={r.periods} decimals={t.decimals} symbol={sym} />

      <details className="table-view">
        <summary>Show as a table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Period from</th>
                <th scope="col">Payouts</th>
                <th scope="col">Fast lane</th>
                <th scope="col">Moved ({sym})</th>
                <th scope="col">Budget used</th>
              </tr>
            </thead>
            <tbody>
              {r.periods.map((p) => (
                <tr key={p.period_start}>
                  <td>{p.period_start}</td>
                  <td>{fmtInt(p.payouts)}</td>
                  <td>{fmtInt(p.fast_laned)}</td>
                  <td>{fmtAmount(p.amount, t.decimals)}</td>
                  <td>{p.budget_used_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="fine">
        Replayed {fmtInt(r.payouts_considered)} payouts in {ms < 10 ? "under 10" : Math.round(ms)} ms in your browser,
        with the same rules engine as the CLI. Only history from before each payout counts, and at most nine claims per
        request. Aggregates only: the simulator never shows who would have qualified.
      </p>
    </div>
  );
}
