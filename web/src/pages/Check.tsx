import { useMemo, useRef, useState, type FormEvent } from "react";
import { DaoPicker } from "../components/DaoPicker";
import { Trace, linesFor, REJECT_TEXT } from "../components/Trace";
import { CopyBlock, ExcludeMembers, Field, Gate, PageHead, Pointer, TextInput, TrustedList } from "../components/ui";
import {
  MAINNET_RPCS,
  MAX_CLAIMS,
  RpcPool,
  TOKENS,
  defaultRules,
  discoverClaims,
  membersOf,
  suggestTrusted,
  summarize,
  verifyLive,
  type ClaimCheck,
  type Payout,
  type Rules,
  type Summary,
} from "../engine";
import { isAccountId } from "../lib/accounts";
import { fmtAmount, fmtInt, tokenKeyById, tokenSymbol, tryUnits } from "../lib/format";
import { href } from "../lib/router";
import type { SnapshotIndex } from "../lib/snapshot";
import { useSnapshot } from "../lib/useSnapshot";

export function Check({ initialAccount }: { initialAccount: string }) {
  const snap = useSnapshot();
  return (
    <div className="page">
      <PageHead eyebrow="Claims" title="Check a record">
        <p>
          Present your own record. Enter your NEAR account to see which of your past payouts a funding DAO would accept as
          claims, then verify each one live against the paying DAO's own proposal on mainnet.
        </p>
      </PageHead>
      <Gate load={snap} what="Loading the mainnet snapshot">
        {(idx) => <CheckBody idx={idx} initialAccount={initialAccount} />}
      </Gate>
    </div>
  );
}

/** DAOs that paid this account by Transfer, most payouts first. */
function payersOf(payouts: Payout[], limit = 10): string[] {
  const n = new Map<string, number>();
  for (const p of payouts) if (p.path === "transfer") n.set(p.dao, (n.get(p.dao) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([d]) => d);
}

/** What verifyLive found running at a paying DAO (RULES.md §8). */
const codeLabel = (v: string) => (v === "custom" ? "custom code" : v === "none" ? "no contract" : `Sputnik ${v}`);

type Live = {
  key: string;
  running: boolean;
  results: (ClaimCheck | undefined)[];
  summary: Summary | null;
  codeVersions: Record<string, string>;
  warnings: string[];
  error: string | null;
};

let mainnet: RpcPool | null = null;

function CheckBody({ idx, initialAccount }: { idx: SnapshotIndex; initialAccount: string }) {
  const [input, setInput] = useState(initialAccount);
  const [account, setAccount] = useState(isAccountId(initialAccount) ? initialAccount : "");
  const [inputError, setInputError] = useState<string | null>(null);
  const [source, setSource] = useState<"payers" | "like">("payers");
  const [likeDao, setLikeDao] = useState("");
  const [trusted, setTrusted] = useState<string[]>(() => (account ? payersOf(idx.byReceiver.get(account) ?? []) : []));
  const [minDaos, setMinDaos] = useState("2");
  const [minPayouts, setMinPayouts] = useState("3");
  const [minNear, setMinNear] = useState("1");
  const [exclude, setExclude] = useState(false);
  const [liveState, setLive] = useState<Live | null>(null);
  const runId = useRef(0);

  const mine = useMemo(() => idx.byReceiver.get(account) ?? [], [idx, account]);
  const members = useMemo(() => membersOf(idx.snap.daos), [idx]);
  const trustedSet = useMemo(() => new Set(trusted), [trusted]);

  const lookUp = (e: FormEvent) => {
    e.preventDefault();
    const a = input.trim().toLowerCase();
    if (!isAccountId(a)) {
      setInputError("Enter a NEAR account id, like alice.near.");
      return;
    }
    setInputError(null);
    setAccount(a);
    setLive(null);
    runId.current++;
    if (source === "payers") setTrusted(payersOf(idx.byReceiver.get(a) ?? []));
    history.replaceState(null, "", href("check", a));
  };

  const md = /^\d+$/.test(minDaos) ? Number(minDaos) : NaN;
  const mp = /^\d+$/.test(minPayouts) ? Number(minPayouts) : NaN;
  const barOk = md >= 1 && md <= MAX_CLAIMS && mp >= 1 && mp <= MAX_CLAIMS && tryUnits(minNear, 24) !== null;
  const rules: Rules | null = barOk ? defaultRules(trusted, { minNear: minNear.trim(), minDaos: md, minPayouts: mp, excludeMembers: exclude }) : null;

  const claims = useMemo(() => (rules && account ? discoverClaims(mine, account, rules, undefined, members) : []),
    [mine, account, members, rules && JSON.stringify(rules)],
  );
  const summary = rules ? summarize(claims, rules) : null;
  const byKey = useMemo(() => new Map(mine.map((p) => [`${p.dao}#${p.proposal_id}`, p])), [mine]);
  // A different bar can keep the same claims but change their verdicts.
  const claimsKey = JSON.stringify([claims, rules]);
  // Results only apply to the exact claims they were read for.
  const live = liveState && liveState.key === claimsKey ? liveState : null;

  const verify = async () => {
    if (!rules || claims.length === 0) return;
    const id = ++runId.current;
    setLive({ key: claimsKey, running: true, results: claims.map(() => undefined), summary: null, codeVersions: {}, warnings: [], error: null });
    mainnet ??= new RpcPool(MAINNET_RPCS, 200, 15_000);
    try {
      const out = await verifyLive(account, claims, rules, "mainnet", {
        rpc: mainnet,
        onResult: (r, i) => {
          if (runId.current !== id) return;
          setLive((l) => (l ? { ...l, results: l.results.map((x, j) => (j === i ? r : x)) } : l));
        },
      });
      if (runId.current === id) {
        setLive((l) => (l ? { ...l, running: false, summary: out.summary, codeVersions: out.code_versions, warnings: out.warnings } : l));
      }
    } catch (e) {
      if (runId.current === id) {
        setLive((l) => (l ? { ...l, running: false, error: `A mainnet RPC didn't answer: ${(e as Error).message}` } : l));
      }
    }
  };

  const pickLike = (d: string) => {
    setLikeDao(d);
    setTrusted(suggestTrusted(idx.snap.payouts, d));
    setLive(null);
  };

  const otherPaths = mine.filter((p) => p.path !== "transfer").length;
  const claimJson = JSON.stringify(claims);
  const cli = `npm run cli -- verify ${account} --trust ${trusted.join(",")} --claims ${claims.map((c) => `${c.dao_id}#${c.proposal_id}`).join(",")}${minNear !== "1" ? ` --min-near ${minNear}` : ""}${md !== 2 ? ` --min-daos ${md}` : ""}${mp !== 3 ? ` --min-payouts ${mp}` : ""}${exclude ? " --exclude-members" : ""}`;

  return (
    <div className="workbench">
      <div className="panel config">
        <form onSubmit={lookUp} className="lookup" aria-label="Look up an account">
          <Field id="chk-account" label="Your NEAR account" error={inputError ?? undefined}>
            <div className="input-row">
              <TextInput id="chk-account" value={input} onChange={setInput} placeholder="alice.near" invalid={!!inputError} />
              <button type="submit" className="btn btn-primary">
                Look up
              </button>
            </div>
          </Field>
        </form>

        <fieldset>
          <legend>Whose payouts count</legend>
          <div className="radios" role="radiogroup" aria-label="Trusted DAOs">
            <label>
              <input
                type="radio"
                name="source"
                checked={source === "payers"}
                onChange={() => {
                  setSource("payers");
                  setTrusted(payersOf(mine));
                  setLive(null);
                }}
              />
              The DAOs that paid this account
            </label>
            <label>
              <input type="radio" name="source" checked={source === "like"} onChange={() => setSource("like")} />
              What a funding DAO would likely trust
            </label>
          </div>
          {source === "like" && (
            <Field id="chk-like" label="Funding DAO" hint="Its own DAO plus the DAOs that paid the same people">
              <DaoPicker id="chk-like" daos={idx.daos} value={likeDao} onPick={pickLike} />
            </Field>
          )}
          <TrustedList
            daos={trusted}
            onRemove={(d) => {
              setTrusted(trusted.filter((x) => x !== d));
              setLive(null);
            }}
          />
          <Field id="chk-add" label="Add a DAO">
            <DaoPicker
              id="chk-add"
              daos={idx.daos}
              exclude={trustedSet}
              clearOnPick
              placeholder="Search to add"
              onPick={(d) => {
                if (!trustedSet.has(d)) setTrusted([...trusted, d]);
                setLive(null);
              }}
            />
          </Field>
        </fieldset>

        <fieldset>
          <legend>The funding DAO's bar</legend>
          <div className="pair">
            <Field id="chk-mindaos" label="Min. DAOs" error={md >= 1 && md <= MAX_CLAIMS ? undefined : "1 to 9"}>
              <TextInput id="chk-mindaos" inputMode="numeric" value={minDaos} onChange={setMinDaos} />
            </Field>
            <Field id="chk-minpay" label="Min. payouts" error={mp >= 1 && mp <= MAX_CLAIMS ? undefined : "1 to 9"}>
              <TextInput id="chk-minpay" inputMode="numeric" value={minPayouts} onChange={setMinPayouts} />
            </Field>
          </div>
          <Field
            id="chk-minnear"
            label="Smallest NEAR payout that counts"
            error={tryUnits(minNear, 24) === null ? "Enter an amount, like 1." : undefined}
            hint="Stablecoin payouts count from 10"
          >
            <TextInput id="chk-minnear" inputMode="decimal" value={minNear} onChange={setMinNear} />
          </Field>
          <ExcludeMembers id="chk-exclude" checked={exclude} onChange={setExclude} />
        </fieldset>
      </div>

      <section className="results" aria-live="polite">
        {!account ? (
          <div className="state empty">
            <p>
              <strong>Enter your account to see your record.</strong>
            </p>
            <p className="muted">
              Nothing is published about an account unless its owner presents it. This page reads public DAO proposals and
              keeps nothing.
            </p>
          </div>
        ) : mine.length === 0 ? (
          <div className="state empty">
            <p>
              <strong>No payouts to {account} in the snapshot.</strong>
            </p>
            <p className="muted">
              The snapshot covers every mainnet Sputnik DAO up to {idx.snap.crawled_to.slice(0, 10)}. Check the spelling, or
              try the account that received the payouts.
            </p>
          </div>
        ) : (
          <div className="result-body" key={claimsKey}>
            <p className="result-kicker acct">{account}</p>
            <h2 className="result-title">
              <span className="big">{claims.length}</span> claimable payout{claims.length === 1 ? "" : "s"} from{" "}
              {summary?.distinct_daos ?? 0} trusted DAO{summary?.distinct_daos === 1 ? "" : "s"}.{" "}
              {summary &&
                (summary.qualifies ? (
                  <span className="pill pill-ok">Meets the bar</span>
                ) : (
                  <span className="pill pill-no">
                    Below the bar: needs {md} DAOs and {mp} payouts
                  </span>
                ))}
            </h2>
            <p className="muted">
              {fmtInt(mine.length)} payout{mine.length === 1 ? "" : "s"} to this account in the snapshot
              {otherPaths ? `, ${fmtInt(otherPaths)} of them bounties, token transfers or Intents, which v1 can't verify on-chain yet` : ""}.
              The lane accepts up to {MAX_CLAIMS} claims per request; these are picked for the most distinct DAOs first, then
              the most recent.
            </p>

            {claims.length > 0 && (
              <>
                <div className="verify-bar">
                  <button type="button" className="btn btn-primary" onClick={verify} disabled={live?.running}>
                    {live?.running ? "Verifying on mainnet" : live?.summary ? "Verify again" : "Verify live on mainnet"}
                  </button>
                  <span className="muted small">
                    Reads each proposal from the paying DAO and applies the verifier contract's rules, then checks that each
                    DAO still runs code its factory published.
                  </span>
                </div>
                {live?.error && (
                  <p className="field-error" role="alert">
                    {live.error}
                  </p>
                )}
                {live?.summary && (
                  <p className={`live-verdict ${live.summary.qualifies ? "is-ok" : "is-no"}`}>
                    Verified on mainnet: {live.summary.payouts} valid payout{live.summary.payouts === 1 ? "" : "s"} from{" "}
                    {live.summary.distinct_daos} DAO{live.summary.distinct_daos === 1 ? "" : "s"}.{" "}
                    {live.summary.qualifies ? "Qualifies for the fast lane." : "Does not qualify under this bar."}
                  </p>
                )}
                {live && live.warnings.length > 0 && (
                  <ul className="warnings" aria-label="Code checks">
                    {live.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}

                <ul className="claims">
                  {claims.map((c, i) => {
                    const p = byKey.get(`${c.dao_id}#${c.proposal_id}`);
                    const key = p ? tokenKeyById(p.token) : undefined;
                    const res = live?.results[i];
                    const state = !live ? "idle" : res === undefined ? "pending" : res.ok ? "ok" : "no";
                    return (
                      <li key={`${c.dao_id}#${c.proposal_id}`} className={`claim claim-${state}`}>
                        <details>
                          <summary>
                            <Pointer dao={c.dao_id} id={c.proposal_id} />
                            <span className="claim-meta">
                              {p && key ? `${fmtAmount(p.amount, TOKENS[key]!.decimals)} ${tokenSymbol(key)}` : ""}
                              {p ? ` · ${new Date(Number(BigInt(p.time_ns) / 1_000_000n)).toISOString().slice(0, 10)}` : ""}
                              {live?.codeVersions[c.dao_id] ? ` · ${codeLabel(live.codeVersions[c.dao_id]!)}` : ""}
                            </span>
                            <span className="claim-state">
                              {state === "idle" && "From the snapshot"}
                              {state === "pending" && "Reading"}
                              {state === "ok" && "Valid on-chain"}
                              {state === "no" && res?.reason && REJECT_TEXT[res.reason]}
                            </span>
                          </summary>
                          <Trace
                            dao={c.dao_id}
                            id={c.proposal_id}
                            account={account}
                            lines={linesFor(state === "idle" || state === "pending" ? undefined : res!.reason, exclude)}
                            verdict={
                              state === "ok"
                                ? { ok: true, text: "Valid claim, read live from the DAO." }
                                : state === "no" && res?.reason
                                  ? { ok: false, text: REJECT_TEXT[res.reason] }
                                  : null
                            }
                          />
                        </details>
                      </li>
                    );
                  })}
                </ul>

                <div className="copies">
                  <CopyBlock label="Claims for register()" text={claimJson} />
                  <CopyBlock label="Same check from the CLI" text={cli} />
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
