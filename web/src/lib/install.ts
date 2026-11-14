// "Install in your DAO": turns the form into the lane's init args, the
// ChangePolicy proposal that adds the fastlane role, and near CLI commands.
// validateInstall() mirrors validate() in contracts/lane/src/lib.rs and adds
// the checks that would make a config valid but useless.

import { MAINNET_FACTORY, MAX_CLAIMS, TESTNET_FACTORY, TOKENS, human, isFactoryDao, type Rules } from "../engine";
import { isAccountId, parseList } from "./accounts";
import { tryUnits } from "./format";

export type Network = "mainnet" | "testnet";

export type FloorInput = { key: string; enabled: boolean; min: string };

export type InstallForm = {
  network: Network;
  dao: string;
  lane: string;
  proposer: string;
  trusted: string;
  floors: FloorInput[];
  minDaos: string;
  minPayouts: string;
  excludeMembers: boolean;
  payToken: string;
  cap: string;
  budget: string;
  periodDays: string;
  vetoHours: string;
  maxAgeDays: string;
  guardians: string;
};

/** What the snapshot knows about the DAO, when it's a crawled mainnet DAO. */
export type DaoFacts = { proposal_period_ns: string | null; proposal_bond: string | null };

export type LaneConfig = {
  rules: Rules;
  pay_token: string;
  per_account_cap: string;
  period_budget: string;
  period_secs: number;
  veto_secs: number;
  max_proposal_age_secs: number;
  guardians: string[];
};

export type InitArgs = { dao: string; factory: string; config: LaneConfig };

export type Field = keyof InstallForm | "floors";

export type Checked = {
  errors: Partial<Record<Field, string>>;
  warnings: string[];
  init: InitArgs | null;
};

export const factoryFor = (n: Network) => (n === "testnet" ? TESTNET_FACTORY : MAINNET_FACTORY);

export function defaultForm(network: Network = "mainnet"): InstallForm {
  return {
    network,
    dao: "",
    lane: "",
    proposer: "",
    trusted: "",
    floors: [
      { key: "near", enabled: true, min: "1" },
      { key: "usdc", enabled: true, min: "10" },
      { key: "usdt", enabled: true, min: "10" },
      { key: "usdc.e", enabled: false, min: "10" },
      { key: "usdt.e", enabled: false, min: "10" },
      { key: "dai", enabled: false, min: "10" },
    ],
    minDaos: "2",
    minPayouts: "3",
    excludeMembers: false,
    payToken: "near",
    cap: "500",
    budget: "2000",
    periodDays: "30",
    vetoHours: "48",
    maxAgeDays: "3",
    guardians: "",
  };
}

const positiveNumber = (s: string) => {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const wholeNumber = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

// Bounds from validate() in contracts/lane/src/lib.rs.
const DAY = 86_400;
export const MAX_VETO_SECS = 30 * DAY;
export const MAX_AGE_SECS = 365 * DAY;
export const MAX_PERIOD_SECS = 10 * MAX_AGE_SECS;
/** The lane refuses a request whose veto window ends this close to the proposal's expiry. */
export const EXPIRY_MARGIN_SECS = 300;

export function validateInstall(f: InstallForm, facts?: DaoFacts | null): Checked {
  const errors: Checked["errors"] = {};
  const warnings: string[] = [];
  const factory = factoryFor(f.network);

  const dao = f.dao.trim().toLowerCase();
  if (!dao) errors.dao = "Enter the DAO that installs the lane.";
  else if (!isFactoryDao(dao, factory)) errors.dao = `Must be a Sputnik DAO: <name>.${factory}`;

  const lane = f.lane.trim().toLowerCase();
  if (!lane) errors.lane = "Enter the account the lane contract will be deployed to.";
  else if (!isAccountId(lane)) errors.lane = "Not a valid NEAR account id.";
  else if (lane === dao) errors.lane = "The lane needs its own account, separate from the DAO.";

  const proposer = f.proposer.trim().toLowerCase();
  if (proposer && !isAccountId(proposer)) errors.proposer = "Not a valid NEAR account id.";

  const trusted = parseList(f.trusted);
  const badTrusted = trusted.filter((d) => !isFactoryDao(d, factory));
  if (trusted.length === 0) errors.trusted = "Trust at least one DAO.";
  else if (badTrusted.length) {
    errors.trusted = `Not Sputnik DAOs on ${f.network}, so their payouts would never count: ${badTrusted.join(", ")}`;
  }

  const tokens: Rules["tokens"] = [];
  for (const fl of f.floors.filter((x) => x.enabled)) {
    const t = TOKENS[fl.key];
    if (!t) continue;
    const min = tryUnits(fl.min, t.decimals);
    if (min === null) {
      errors.floors = `The floor for ${fl.key.toUpperCase()} isn't an amount.`;
      continue;
    }
    if (min === "0") warnings.push(`A ${fl.key.toUpperCase()} floor of 0 lets one-yocto payouts count as track record.`);
    tokens.push({ token_id: t.id, min_amount: min });
  }
  if (!errors.floors && tokens.length === 0) errors.floors = "Count at least one token.";

  const minDaos = wholeNumber(f.minDaos);
  const minPayouts = wholeNumber(f.minPayouts);
  if (minDaos === null || minDaos < 1) errors.minDaos = "A whole number, at least 1.";
  else if (minDaos > MAX_CLAIMS) errors.minDaos = `At most ${MAX_CLAIMS}: a request carries ${MAX_CLAIMS} claims.`;
  else if (trusted.length && minDaos > trusted.length) {
    errors.minDaos = `Only ${trusted.length} DAO${trusted.length === 1 ? " is" : "s are"} trusted, so nobody could qualify.`;
  }
  if (minPayouts === null || minPayouts < 1) errors.minPayouts = "A whole number, at least 1.";
  else if (minPayouts > MAX_CLAIMS) errors.minPayouts = `At most ${MAX_CLAIMS}: a request carries ${MAX_CLAIMS} claims.`;
  if (minDaos !== null && minPayouts !== null && minPayouts < minDaos && !errors.minDaos && !errors.minPayouts) {
    warnings.push(`Meeting ${minDaos} DAOs already means ${minDaos} payouts, so the payout minimum has no effect.`);
  }

  const pay = TOKENS[f.payToken];
  if (!pay) errors.payToken = "Pick the token the lane pays in.";
  const cap = pay ? tryUnits(f.cap, pay.decimals) : null;
  const budget = pay ? tryUnits(f.budget, pay.decimals) : null;
  if (pay && (cap === null || cap === "0")) errors.cap = "A positive amount.";
  if (pay && (budget === null || budget === "0")) errors.budget = "A positive amount.";
  if (cap !== null && budget !== null && BigInt(cap) > BigInt(budget)) {
    errors.cap = "The per-account cap can't exceed the period budget.";
  }
  if (f.network === "testnet" && f.payToken !== "near") {
    warnings.push("The token table holds mainnet token contracts; on testnet use NEAR.");
  }

  const periodDays = positiveNumber(f.periodDays);
  const periodSecs = periodDays === null ? 0 : Math.round(periodDays * DAY);
  if (periodSecs <= 0) errors.periodDays = "A positive number of days.";
  else if (periodSecs > MAX_PERIOD_SECS) errors.periodDays = "At most 10 years (3,650 days).";

  const vetoHours = positiveNumber(f.vetoHours);
  const vetoSecs = vetoHours === null ? -1 : Math.round(vetoHours * 3600);
  if (vetoSecs < 0) errors.vetoHours = "A number of hours (decimals are fine).";
  else if (vetoSecs > MAX_VETO_SECS) errors.vetoHours = "At most 30 days (720 hours).";
  else if (vetoSecs === 0) warnings.push("With no veto window, guardians and the council can't stop a request.");
  const daoPeriodSecs = facts?.proposal_period_ns ? Number(BigInt(facts.proposal_period_ns) / 1_000_000_000n) : null;
  if (!errors.vetoHours && vetoSecs >= 0 && daoPeriodSecs !== null && vetoSecs + EXPIRY_MARGIN_SECS >= daoPeriodSecs) {
    errors.vetoHours =
      `Must end at least 5 minutes before the DAO's proposals expire (${+(daoPeriodSecs / 3600).toFixed(2)} h), ` +
      "or the lane refuses every request.";
  }

  const maxAgeDays = positiveNumber(f.maxAgeDays);
  const maxAgeSecs = maxAgeDays === null ? 0 : Math.round(maxAgeDays * DAY);
  if (maxAgeSecs <= 0) errors.maxAgeDays = "A positive number of days.";
  else if (maxAgeSecs > MAX_AGE_SECS) errors.maxAgeDays = "At most a year (365 days).";
  if (daoPeriodSecs !== null && !errors.maxAgeDays && !errors.vetoHours && maxAgeSecs + vetoSecs + EXPIRY_MARGIN_SECS > daoPeriodSecs) {
    warnings.push("A proposal registered near the maximum age would expire before its veto window ends, so the lane would refuse it.");
  }

  const guardians = parseList(f.guardians);
  const badGuardians = guardians.filter((g) => !isAccountId(g));
  if (badGuardians.length) errors.guardians = `Not valid account ids: ${badGuardians.join(", ")}`;
  if (guardians.length === 0) warnings.push("No guardians: only the council's reject threshold can stop a request.");

  const ok = Object.keys(errors).length === 0;
  return {
    errors,
    warnings,
    init: ok
      ? {
          dao,
          factory,
          config: {
            rules: {
              trusted_daos: trusted,
              tokens,
              min_distinct_daos: minDaos!,
              min_payouts: minPayouts!,
              exclude_members: f.excludeMembers,
            },
            pay_token: pay!.id,
            per_account_cap: cap!,
            period_budget: budget!,
            period_secs: periodSecs,
            veto_secs: vetoSecs,
            max_proposal_age_secs: maxAgeSecs,
            guardians,
          },
        }
      : null,
  };
}

/** The ChangePolicy kind that installs the lane (RULES.md §3, Install). */
export function roleProposalKind(lane: string) {
  return {
    ChangePolicyAddOrUpdateRole: {
      role: {
        name: "fastlane",
        kind: { Group: [lane] },
        permissions: ["transfer:VoteApprove"],
        vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
      },
    },
  };
}

export const LANE_WASM = "contracts/target/near/tenured_lane/tenured_lane.wasm";

/** near CLI (near-cli-rs) commands, same syntax as scripts/testnet-setup.sh. */
export function installCommands(init: InitArgs, lane: string, network: Network, proposer: string, facts?: DaoFacts | null) {
  const bond = facts?.proposal_bond ? human(facts.proposal_bond, 24) : "1";
  const signer = proposer || "<your-account>";
  const net = `network-config ${network} sign-with-legacy-keychain send`;
  const proposal = { proposal: { description: "Install the Tenured fast lane", kind: roleProposalKind(lane) } };
  return {
    build: "./scripts/build-contracts.sh",
    deploy: [
      `near contract deploy ${lane} use-file ${LANE_WASM} \\`,
      `  with-init-call new json-args '${JSON.stringify(init)}' \\`,
      `  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \\`,
      `  ${net}`,
    ].join("\n"),
    propose: [
      `near contract call-function as-transaction ${init.dao} add_proposal \\`,
      `  json-args '${JSON.stringify(proposal)}' \\`,
      `  prepaid-gas '150.0 Tgas' attached-deposit '${bond} NEAR' \\`,
      `  sign-as ${signer} ${net}`,
    ].join("\n"),
    listKeys: `near account list-keys ${lane} network-config ${network} now`,
    deleteKey: [`near account delete-keys ${lane} public-keys <ed25519:the-key-listed-above> \\`, `  ${net}`].join("\n"),
    bond,
  };
}
