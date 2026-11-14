// The web app runs the same rules engine as the CLI and the contracts'
// fixtures. Everything is imported from offchain/src so there is one copy.

export { checkClaim, checkProposal, isFactoryDao, isMember, staticChecks, summarize } from "../../offchain/src/rules.js";
export type { Claim, Reject, Rules, Summary, TokenFloor } from "../../offchain/src/rules.js";
export { MAX_CLAIMS, discoverClaims, membersOf, simulate, suggestTrusted } from "../../offchain/src/simulate.js";
export type { Members, PeriodRow, SimConfig, SimResult } from "../../offchain/src/simulate.js";
export { TOKENS, defaultRules, human, units } from "../../offchain/src/tokens.js";
export { MAINNET_RPCS, TESTNET_RPCS, RpcPool, ViewError } from "../../offchain/src/rpc.js";
export { scanClaims, verifyLive } from "../../offchain/src/verify.js";
export type { ClaimCheck, Network, Verification } from "../../offchain/src/verify.js";
export { MAINNET_FACTORY, TESTNET_FACTORY } from "../../offchain/src/sputnik.js";
export type { Policy, Proposal } from "../../offchain/src/sputnik.js";
export type { DaoInfo, Payout, Snapshot } from "../../offchain/src/types.js";
