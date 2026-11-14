import { useState } from "react";
import type { PeriodRow } from "../engine";
import { fmtAmount, fmtInt } from "../lib/format";

const H = 180;
const PAD = { top: 12, right: 8, bottom: 26, left: 36 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Payouts per period, split into the ones the lane would have approved and
 * the ones that still went to a council vote. One measure, one axis.
 */
export function PeriodChart({ rows, decimals, symbol }: { rows: PeriodRow[]; decimals: number; symbol: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length === 0) return null;

  const W = Math.max(560, rows.length * 14 + PAD.left + PAD.right);
  const max = niceMax(Math.max(...rows.map((r) => r.payouts)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / rows.length;
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  let lastYear = "";
  const h = hover === null ? null : rows[hover]!;

  return (
    <div className="chart">
      <div className="chart-legend" aria-hidden="true">
        <span>
          <i className="sw sw-lane" /> Fast lane would approve
        </span>
        <span>
          <i className="sw sw-vote" /> Still a council vote
        </span>
      </div>
      <div className="chart-scroll">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={`Payouts per period, ${rows.length} periods. Table below.`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                {fmtInt(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = PAD.left + i * slot + (slot - bw) / 2;
            const laneTop = y(r.fast_laned);
            const totalTop = y(r.payouts);
            const year = r.period_start.slice(0, 4);
            const showYear = year !== lastYear;
            lastYear = year;
            const rx = Math.min(3, bw / 2);
            return (
              <g key={r.period_start} className={hover === i ? "bar is-hover" : "bar"}>
                {r.payouts > r.fast_laned && (
                  <rect className="b-vote" x={x} y={totalTop} width={bw} height={Math.max(0, laneTop - totalTop - (r.fast_laned ? 2 : 0))} rx={rx} />
                )}
                {r.fast_laned > 0 && <rect className="b-lane" x={x} y={laneTop} width={bw} height={y(0) - laneTop} rx={rx} />}
                {showYear && (
                  <text className="tick" x={x} y={H - 8}>
                    {year}
                  </text>
                )}
                <rect
                  className="hit"
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={innerH}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  aria-label={`${r.period_start}: ${r.payouts} payouts, ${r.fast_laned} through the fast lane`}
                />
              </g>
            );
          })}
          <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
        </svg>
      </div>
      <p className="chart-readout" aria-live="polite">
        {h ? (
          <>
            <strong>Period from {h.period_start}</strong> · {fmtInt(h.payouts)} payouts · {fmtInt(h.fast_laned)} fast-laned ·{" "}
            {fmtAmount(h.amount, decimals)} {symbol} moved · {h.budget_used_pct}% of budget
          </>
        ) : (
          <span className="muted">Hover or tab through the bars for each period.</span>
        )}
      </p>
    </div>
  );
}
