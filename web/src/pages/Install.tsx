import { useState } from "react";
import { CopyBlock, ExcludeMembers, Field, PageHead, TextInput } from "../components/ui";
import { suggestTrusted, TOKENS } from "../engine";
import { fmtAmount, TOKEN_LABELS, tokenSymbol } from "../lib/format";
import {
  defaultForm,
  factoryFor,
  installCommands,
  roleProposalKind,
  validateInstall,
  type DaoFacts,
  type InstallForm,
  type Network,
} from "../lib/install";
import { useSnapshot } from "../lib/useSnapshot";

export function Install() {
  const [f, setF] = useState<InstallForm>(() => defaultForm("mainnet"));
  const snap = useSnapshot();
  const set = <K extends keyof InstallForm>(k: K) => (v: InstallForm[K]) => setF((x) => ({ ...x, [k]: v }));

  const daoId = f.dao.trim().toLowerCase();
  const idx = snap.status === "ready" ? snap.value : null;
  const info = f.network === "mainnet" && idx ? idx.info.get(daoId) : undefined;
  const facts: DaoFacts | null = info ? { proposal_bond: info.proposal_bond, proposal_period_ns: info.proposal_period_ns } : null;
  const checked = validateInstall(f, facts);
  const e = checked.errors;
  const cmds = checked.init ? installCommands(checked.init, f.lane.trim().toLowerCase(), f.network, f.proposer.trim().toLowerCase(), facts) : null;
  const sym = tokenSymbol(f.payToken);
  const factory = factoryFor(f.network);

  const switchNetwork = (n: Network) => setF((x) => ({ ...x, network: n, payToken: n === "testnet" ? "near" : x.payToken }));

  return (
    <div className="page">
      <PageHead eyebrow="Setup" title="Install in your DAO">
        <p>
          Fill in your lane's limits. This page writes the lane's init arguments, the one policy proposal that gives it the
          <code>fastlane</code> role, and the near CLI commands. Nothing is sent from here: you deploy and propose from
          your own wallet, and the council votes as usual.
        </p>
      </PageHead>

      <div className="workbench install">
        <form className="panel config" onSubmit={(ev) => ev.preventDefault()} aria-label="Lane settings" noValidate>
          <div className="seg" role="radiogroup" aria-label="Network">
            {(["mainnet", "testnet"] as const).map((n) => (
              <label key={n} className={f.network === n ? "is-on" : ""}>
                <input type="radio" name="network" checked={f.network === n} onChange={() => switchNetwork(n)} />
                {n === "mainnet" ? "Mainnet" : "Testnet"}
              </label>
            ))}
          </div>

          <fieldset>
            <legend>Accounts</legend>
            <Field
              id="in-dao"
              label="Your DAO"
              error={e.dao}
              hint={info ? `Found in the snapshot: proposal bond ${fmtAmount(info.proposal_bond ?? "0", 24)} NEAR` : `<name>.${factory}`}
            >
              <TextInput id="in-dao" value={f.dao} onChange={set("dao")} placeholder={`your-dao.${factory}`} invalid={!!e.dao} />
            </Field>
            <Field id="in-lane" label="Lane account" error={e.lane} hint="A new, empty account the lane contract is deployed to">
              <TextInput id="in-lane" value={f.lane} onChange={set("lane")} placeholder={f.network === "mainnet" ? "your-dao-lane.near" : "your-dao-lane.testnet"} invalid={!!e.lane} />
            </Field>
            <Field id="in-proposer" label="Who files the install proposal" error={e.proposer} hint="Optional; used in the commands">
              <TextInput id="in-proposer" value={f.proposer} onChange={set("proposer")} placeholder={f.network === "mainnet" ? "you.near" : "you.testnet"} invalid={!!e.proposer} />
            </Field>
          </fieldset>

          <fieldset>
            <legend>Whose payouts count</legend>
            <Field id="in-trusted" label="Trusted DAOs" error={e.trusted} hint="One per line or comma-separated. Your own DAO can be on it.">
              <textarea
                id="in-trusted"
                rows={4}
                value={f.trusted}
                onChange={(ev) => set("trusted")(ev.target.value)}
                aria-invalid={!!e.trusted || undefined}
                aria-describedby="in-trusted-msg"
                spellCheck={false}
                placeholder={`partner-dao.${factory}`}
              />
            </Field>
            {info && idx && (
              <button type="button" className="btn-quiet" onClick={() => set("trusted")(suggestTrusted(idx.snap.payouts, daoId).join("\n"))}>
                Fill from who your DAO has paid
              </button>
            )}
            <div className="floors" role="group" aria-labelledby="floors-label">
              <p id="floors-label" className="label">
                Tokens that count, and the smallest payout in each
              </p>
              {e.floors && (
                <p className="field-error" role="alert">
                  {e.floors}
                </p>
              )}
              {f.floors.map((fl, i) => (
                <div className="floor" key={fl.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={fl.enabled}
                      onChange={(ev) => set("floors")(f.floors.map((x, j) => (j === i ? { ...x, enabled: ev.target.checked } : x)))}
                    />
                    {TOKEN_LABELS[fl.key]}
                  </label>
                  <input
                    aria-label={`Smallest ${TOKEN_LABELS[fl.key]} payout that counts`}
                    inputMode="decimal"
                    value={fl.min}
                    disabled={!fl.enabled}
                    onChange={(ev) => set("floors")(f.floors.map((x, j) => (j === i ? { ...x, min: ev.target.value } : x)))}
                  />
                </div>
              ))}
            </div>
            <div className="pair">
              <Field id="in-mindaos" label="Min. DAOs" error={e.minDaos}>
                <TextInput id="in-mindaos" inputMode="numeric" value={f.minDaos} onChange={set("minDaos")} invalid={!!e.minDaos} />
              </Field>
              <Field id="in-minpay" label="Min. payouts" error={e.minPayouts}>
                <TextInput id="in-minpay" inputMode="numeric" value={f.minPayouts} onChange={set("minPayouts")} invalid={!!e.minPayouts} />
              </Field>
            </div>
            <ExcludeMembers id="in-exclude" checked={f.excludeMembers} onChange={set("excludeMembers")} />
          </fieldset>

          <fieldset>
            <legend>Limits</legend>
            <Field id="in-pay" label="Pay token" error={e.payToken} hint="Fixed for the life of the lane">
              <select id="in-pay" value={f.payToken} onChange={(ev) => set("payToken")(ev.target.value)}>
                {Object.keys(TOKENS).map((k) => (
                  <option key={k} value={k} disabled={f.network === "testnet" && k !== "near"}>
                    {TOKEN_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="pair">
              <Field id="in-cap" label={`Per-account cap (${sym})`} error={e.cap} hint="Per period">
                <TextInput id="in-cap" inputMode="decimal" value={f.cap} onChange={set("cap")} invalid={!!e.cap} />
              </Field>
              <Field id="in-budget" label={`Period budget (${sym})`} error={e.budget} hint="The most the lane can move">
                <TextInput id="in-budget" inputMode="decimal" value={f.budget} onChange={set("budget")} invalid={!!e.budget} />
              </Field>
            </div>
            <div className="pair">
              <Field id="in-period" label="Period (days)" error={e.periodDays} hint="Fixed for the life of the lane">
                <TextInput id="in-period" inputMode="decimal" value={f.periodDays} onChange={set("periodDays")} invalid={!!e.periodDays} />
              </Field>
              <Field id="in-age" label="Max. proposal age (days)" error={e.maxAgeDays} hint="Up to a year">
                <TextInput id="in-age" inputMode="decimal" value={f.maxAgeDays} onChange={set("maxAgeDays")} invalid={!!e.maxAgeDays} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend>Veto</legend>
            <Field
              id="in-veto"
              label="Veto window (hours)"
              error={e.vetoHours}
              hint={
                info?.proposal_period_ns
                  ? `Your DAO's proposals expire after ${+(Number(BigInt(info.proposal_period_ns) / 1_000_000_000n) / 3600).toFixed(1)} h`
                  : "Up to 30 days, and shorter than your DAO's proposal period"
              }
            >
              <TextInput id="in-veto" inputMode="decimal" value={f.vetoHours} onChange={set("vetoHours")} invalid={!!e.vetoHours} />
            </Field>
            <Field id="in-guardians" label="Guardians" error={e.guardians} hint="Each can stop a request alone during the window">
              <textarea
                id="in-guardians"
                rows={2}
                value={f.guardians}
                onChange={(ev) => set("guardians")(ev.target.value)}
                aria-invalid={!!e.guardians || undefined}
                aria-describedby="in-guardians-msg"
                spellCheck={false}
                placeholder={f.network === "mainnet" ? "guardian.near" : "guardian.testnet"}
              />
            </Field>
          </fieldset>
        </form>

        <section className="results outputs" aria-live="polite">
          {checked.warnings.length > 0 && (
            <ul className="warnings">
              {checked.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {!checked.init || !cmds ? (
            <div className="state empty">
              <p>
                <strong>Fill in the highlighted fields to generate the install.</strong>
              </p>
              <p className="muted">
                The checks match the lane contract's own: a period of up to 10 years, a proposal age of up to a year, a
                veto window of up to 30 days, a cap no larger than the budget, at least one trusted DAO and one counted
                token, and a bar of at least one DAO and one payout. A few more catch settings that would never pay anyone.
              </p>
            </div>
          ) : (
            <>
              <h2 className="sub">1 · Build and deploy the lane</h2>
              <p className="muted small">
                From a checkout of the repository. The lane is initialised for <code>{checked.init.dao}</code> in the same
                transaction.
              </p>
              <CopyBlock label="Build the contracts" text={cmds.build} />
              <CopyBlock label="Deploy with init call" text={cmds.deploy} />

              <h2 className="sub">2 · Propose the fastlane role</h2>
              <p className="muted small">
                An ordinary <code>ChangePolicyAddOrUpdateRole</code> proposal, with your DAO's bond of {cmds.bond} NEAR.
                Your council approves it in Sputnik or Trezu like any other.
              </p>
              <CopyBlock label="File the proposal" text={cmds.propose} />

              <h2 className="sub">3 · Remove the lane's full-access key</h2>
              <p className="muted small">
                After this, nobody can change the lane's code. Only the DAO can change its config, through a proposal calling
                configure, and even the DAO can't change the pay token or the period length.
              </p>
              <CopyBlock label="Find the key" text={cmds.listKeys} />
              <CopyBlock label="Delete it" text={cmds.deleteKey} />

              <h2 className="sub">Reference</h2>
              <CopyBlock label="Init arguments for new()" text={JSON.stringify(checked.init, null, 2)} />
              <CopyBlock label="Proposal kind" text={JSON.stringify(roleProposalKind(f.lane.trim().toLowerCase()), null, 2)} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
