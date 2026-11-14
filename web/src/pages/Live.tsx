import { useCallback, useEffect, useState } from "react";
import { CopyBlock, DaoName, Failed, Field, Loading, PageHead, Pointer, Row, TextInput } from "../components/ui";
import { nearblocks } from "../lib/accounts";
import { fmtAmount, fmtDuration, fmtInt, tryUnits } from "../lib/format";
import { DEMO, demoCommands, expiresInSecs, readLive, statusView, vetoRemainingSecs, type LaneRequest, type LiveState } from "../lib/lane";

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Acct({ id, label }: { id: string; label: string }) {
  return (
    <div className="acct-card">
      <span className="acct-label">{label}</span>
      <a className="acct" href={nearblocks("testnet", id)} target="_blank" rel="noreferrer">
        {id.endsWith(".sputnikv2.testnet") ? <DaoName dao={id} /> : id}
      </a>
    </div>
  );
}

type Reading = { data?: LiveState; error?: string; loading: boolean };

export function Live() {
  const [r, setR] = useState<Reading>({ loading: true });
  const refresh = useCallback(() => {
    setR((x) => ({ ...x, loading: true, error: undefined }));
    readLive().then(
      (data) => setR({ data, loading: false }),
      (e: Error) => setR((x) => ({ ...x, loading: false, error: `Testnet RPC didn't answer: ${e.message}` })),
    );
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="page">
      <PageHead eyebrow="Testnet" title="The live lane">
        <p>
          The demo from <code>scripts/testnet-setup.sh</code>, read live from testnet with view calls. A fund DAO has
          installed the lane; a contributor with three past payouts from two other DAOs files and registers proposals.
        </p>
      </PageHead>
      <div className="acct-strip">
        <Acct id={DEMO.lane} label="Lane" />
        <Acct id={DEMO.dao} label="Fund DAO" />
        <Acct id={DEMO.verifier} label="Verifier" />
      </div>
      {r.data ? (
        <>
          {r.error && <Failed error={r.error} retry={refresh} />}
          <LiveView s={r.data} onRefresh={refresh} refreshing={r.loading} />
        </>
      ) : r.error ? (
        <Failed error={r.error} retry={refresh} />
      ) : (
        <Loading what="Reading the lane, the DAO and the verifier on testnet" />
      )}
    </div>
  );
}

function LiveView({ s, onRefresh, refreshing }: { s: LiveState; onRefresh: () => void; refreshing: boolean }) {
  const now = useNow();
  const c = s.config;
  const nearFloor = c.rules.tokens.find((t) => t.token_id === "");
  const usedPct = BigInt(s.usage.period_budget) > 0n ? Number((BigInt(s.usage.used_by_period) * 1000n) / BigInt(s.usage.period_budget)) / 10 : 0;

  const [amount, setAmount] = useState("0.5");
  const [proposalId, setProposalId] = useState(String(s.nextProposalId));
  const waiting = s.requests.filter((r) => statusView(r.status).name === "Waiting");
  const [requestId, setRequestId] = useState(String((waiting.at(-1) ?? s.requests.at(-1))?.id ?? 0));
  const yocto = tryUnits(amount, 24);
  const cmds = demoCommands({
    amountYocto: yocto ?? "0",
    proposalId,
    requestId,
    bond: s.policy.proposal_bond,
    storageDeposit: s.storageDeposit,
  });

  return (
    <>
      <div className="live-bar">
        <span className="muted small">
          Read at {new Date(s.readAt).toLocaleTimeString()} from {s.requests.length} request{s.requests.length === 1 ? "" : "s"}
        </span>
        <button type="button" className="btn" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Reading" : "Read again"}
        </button>
      </div>

      <section className="section" aria-labelledby="reqs">
        <div className="section-head">
          <h2 id="reqs">Requests</h2>
          <p className="muted">Every registration, newest first, with the fund DAO's own status for the proposal.</p>
        </div>
        {s.requests.length === 0 ? (
          <div className="state empty">No requests yet. File and register one with the commands below.</div>
        ) : (
          <ul className="requests">
            {[...s.requests].reverse().map((r) => (
              <RequestRow key={r.id} r={r} now={now} daoStatus={s.proposals.get(r.proposal_id)?.status} />
            ))}
          </ul>
        )}
      </section>

      <div className="split section">
        <section aria-labelledby="cfg">
          <h2 id="cfg">Lane config</h2>
          <p className="muted small">
            Set by the DAO at deploy, and changeable only by a DAO proposal. <code>get_config</code>
          </p>
          <dl className="ledger">
            <Row
              label="Trusted DAOs"
              value={fmtInt(c.rules.trusted_daos.length)}
              note={c.rules.trusted_daos.map((d) => d.split(".")[0]).join(", ")}
            />
            <Row label="Qualifying bar" value={`${c.rules.min_distinct_daos} DAOs · ${c.rules.min_payouts} payouts`} />
            <Row
              label="Payouts to the paying DAO's members"
              value={c.rules.exclude_members ? "Excluded" : "Counted"}
              note="rule 9, read from each paying DAO's policy"
            />
            {nearFloor && <Row label="Smallest NEAR payout that counts" value={`${fmtAmount(nearFloor.min_amount, 24)} NEAR`} />}
            <Row label="Per-account cap" value={`${fmtAmount(c.per_account_cap, 24)} NEAR`} note="per period" />
            <Row label="Period budget" value={`${fmtAmount(c.period_budget, 24)} NEAR`} note={`${fmtPct1(usedPct)} used this period`} tone="veto" />
            <Row label="Period" value={fmtDuration(c.period_secs)} />
            <Row label="Veto window" value={fmtDuration(c.veto_secs)} tone="veto" />
            <Row label="Max proposal age" value={fmtDuration(c.max_proposal_age_secs)} />
            <Row label="Guardians" value={fmtInt(c.guardians.length)} note={c.guardians.join(", ")} />
          </dl>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct} aria-label="Period budget used">
            <span style={{ width: `${Math.min(100, usedPct)}%` }} />
          </div>
        </section>

        <section aria-labelledby="pol">
          <h2 id="pol">Fund DAO policy</h2>
          <p className="muted small">
            Roles in <DaoName dao={s.dao} />. <code>get_policy</code>
          </p>
          <ul className="roles">
            {s.policy.roles.map((role) => {
              const lane = role.name === "fastlane";
              const members = typeof role.kind === "object" && "Group" in role.kind ? role.kind.Group : null;
              return (
                <li key={role.name} className={lane ? "role is-lane" : "role"}>
                  <div className="role-head">
                    <strong>{role.name}</strong>
                    {lane && <span className="pill pill-accent">Installed by one proposal</span>}
                  </div>
                  <p className="role-members">{members ? members.join(", ") : typeof role.kind === "string" ? role.kind : JSON.stringify(role.kind)}</p>
                  <p className="role-perms">
                    {role.permissions.map((p) => (
                      <code key={p}>{p}</code>
                    ))}
                  </p>
                  {lane && (
                    <p className="small">
                      One permission, approve transfers, with a 1/1 role threshold. It can't propose, reject or touch any
                      other kind of proposal.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted small">
            Verifier at {DEMO.verifier} reads claims for DAOs from {s.verifierFactory ?? "an unreachable factory"}.
          </p>
        </section>
      </div>

      <section className="section" aria-labelledby="try">
        <div className="section-head">
          <h2 id="try">Run it yourself</h2>
          <p className="muted">
            near CLI commands, the same as <code>scripts/testnet-demo.sh</code>. They sign with the demo accounts, so run
            them with your own credentials or the setup script's.
          </p>
        </div>
        <div className="cmd-inputs">
          <Field id="live-amt" label="Amount (NEAR)" error={yocto === null ? "Enter an amount, like 0.5." : undefined}>
            <TextInput id="live-amt" inputMode="decimal" value={amount} onChange={setAmount} />
          </Field>
          <Field id="live-pid" label="Proposal id" hint="Next id in the fund DAO">
            <TextInput id="live-pid" inputMode="numeric" value={proposalId} onChange={setProposalId} />
          </Field>
          <Field id="live-rid" label="Request id" hint="For execute and veto">
            <TextInput id="live-rid" inputMode="numeric" value={requestId} onChange={setRequestId} />
          </Field>
        </div>
        <div className="steps">
          <CopyBlock label="1 · File a proposal, as the contributor" text={cmds.file} />
          <CopyBlock label={`2 · Register it with three claims and the ${fmtAmount(s.storageDeposit, 24)} NEAR storage deposit`} text={cmds.register} />
          <CopyBlock label="3 · Execute after the veto window, as anyone" text={cmds.execute} />
          <CopyBlock label="Or veto during the window, as the guardian" text={cmds.veto} />
          <CopyBlock label="Settle a request left Voted, as anyone" text={cmds.recheck} />
        </div>
      </section>
    </>
  );
}

const fmtPct1 = (n: number) => `${n % 1 ? n.toFixed(1) : n}%`;

const TONE: Record<string, string> = {
  Checking: "pill-accent",
  Waiting: "pill-veto",
  Approving: "pill-accent",
  Voted: "pill-accent",
  Approved: "pill-ok",
  Vetoed: "pill-no",
  Refused: "pill-no",
};

function RequestRow({ r, now, daoStatus }: { r: LaneRequest; now: number; daoStatus?: string }) {
  const st = statusView(r.status);
  const left = vetoRemainingSecs(r, now);
  const expires = expiresInSecs(r, now);
  return (
    <li className="request">
      <div className="req-id">#{r.id}</div>
      <div className="req-main">
        <p className="req-line">
          <a className="acct" href={nearblocks("testnet", r.account_id)} target="_blank" rel="noreferrer">
            {r.account_id}
          </a>{" "}
          asks for <strong>{fmtAmount(r.amount, 24)} NEAR</strong> through <Pointer dao={DEMO.dao} id={r.proposal_id} />
        </p>
        <p className="req-sub muted small">
          {r.distinct_daos || r.payouts ? `Record: ${r.payouts} payouts from ${r.distinct_daos} DAOs` : "No valid record"}
          {daoStatus ? ` · DAO status ${daoStatus}` : ""}
        </p>
      </div>
      <div className="req-status">
        <span className={`pill ${TONE[st.name]}`}>{st.name}</span>
        {st.detail && <p className="small muted">{st.detail}</p>}
        {left !== null && (
          <p className="small countdown">
            {left > 0 ? (
              <>
                Veto window: <strong>{fmtDuration(left)}</strong> left
              </>
            ) : (
              "Window passed. Anyone can execute."
            )}
          </p>
        )}
        {expires !== null && (
          <p className="small muted">{expires > 0 ? `Proposal expires in ${fmtDuration(expires)}` : "Proposal has expired"}</p>
        )}
      </div>
    </li>
  );
}
