# Rules

This file is the specification. The contracts, the off-chain rules engine and the simulator all implement exactly these rules, and the shared test fixtures in `fixtures/` check that they agree.

## 1. Claims

A **claim** is a pointer to one past DAO proposal: `(dao_id, proposal_id)`.

The contributor chooses which claims to present. Nothing about an account is published unless its owner presents it.

A claim is **valid** for contributor `C` under a funding DAO's config when all of these hold, read live from the paying DAO with `get_proposal`:

| # | Check | Why |
| --- | --- | --- |
| 1 | `dao_id` is a direct sub-account of the Sputnik factory (`*.sputnik-dao.near` on mainnet, `*.sputnikv2.testnet` on testnet) | Only the factory can create those names, so the account started life as a Sputnik DAO. A DAO can later replace its own code (see §8) |
| 2 | `dao_id` is in the funding DAO's `trusted_daos` list (the funding DAO may list itself) | Trust is relative: a ring of self-made DAOs earns nothing unless a funding DAO chooses to trust it |
| 3 | `status == "Approved"` | Only work the paying DAO actually approved counts |
| 4 | `kind` is `Transfer` | v1 counts direct payouts; see §6 for what the off-chain records also read |
| 5 | `receiver_id == C` | You can only present your own payouts |
| 6 | `token_id` is in the config's `tokens` list (`""` means native NEAR) | Payouts in junk tokens don't count |
| 7 | `amount >= min_amount` for that token | One-yocto "payouts" don't count |
| 8 | The same `(dao_id, proposal_id)` appears only once in a request | No double counting |
| 9 | *Optional* (`exclude_members`): `C` is not in any group role of the paying DAO, read live with `get_policy`. An unreadable policy counts as membership | Councils paying themselves don't build a record. On mainnet, 30.7% of payouts go to current members of the paying DAO. Membership is the DAO's **current** policy, not its policy at the time of the payout |

## 2. Qualifying

A contributor **qualifies** when their valid claims satisfy both:

- `distinct_daos >= min_distinct_daos`: how many different trusted DAOs paid them
- `payouts >= min_payouts`: how many valid claims in total

The funding DAO sets both numbers. A request carries at most `MAX_CLAIMS` claims (one cross-contract call each; the value is set from measured gas).

A record is permanent history, not a voucher. The same claims can qualify a contributor again next period, and the money limits in §3 are what bound payouts.

## 3. The fast lane

The lane is a Sputnik **role member, never a treasury**. It holds no tokens, and money moves only from the DAO's own treasury through an ordinary approved `Transfer` proposal.

**Install.** One `ChangePolicy` proposal adds a role `fastlane = Group([lane account])` with the single permission `transfer:VoteApprove`, and a role vote policy of 1/1 `RoleWeight`. The lane can't file proposals; contributors file their own. The DAO then sets the lane config:

| Field | Meaning |
| --- | --- |
| `trusted_daos` | DAOs whose past payouts count (may include itself) |
| `tokens`, `min_amount` | Which payout tokens count, and their floors |
| `min_distinct_daos`, `min_payouts` | The qualifying bar |
| `pay_token` | The token the lane may request payouts in |
| `per_account_cap` | Most one contributor can receive per period |
| `period_budget` | Most the lane can request in total per period |
| `period_secs` | Length of a period; `period = floor(block_timestamp / period_secs)` |
| `veto_secs` | How long a request waits before it can be approved. Must be shorter than the DAO's `proposal_period` |
| `guardians` | Accounts that may veto a request alone |
| `max_proposal_age_secs` | How old a proposal may be when registered, so a nearly expired proposal can't slip through |

**Request.**

1. Contributor `C` files an ordinary `Transfer` proposal in the DAO, from their own wallet, paying the DAO's normal bond. Sputnik handles the bond exactly as it does for any proposal.
2. `C` calls `register(proposal_id, amount, claims, nonce)` on the lane and attaches 0.01 NEAR for the storage the request uses (`storage_deposit()`; anything above it is refunded). The request is kept as history, so the deposit stays with the lane. Without it, anyone could drain the lane's balance with junk registrations.
3. `(C, nonce)` must not have been used before, so retries don't double-register.
4. `amount <= per_account_cap - used(C, period)` and `amount <= period_budget - used(period)`. Both are **debited before** any cross-contract call.
5. The lane reads the proposal from its DAO and requires:
   - `proposer == C` and `receiver_id == C`
   - `token_id == pay_token`
   - its amount equals `amount`
   - status `InProgress`
   - submitted within the last `max_proposal_age_secs`
   - not registered before

   **The lane only ever votes on proposals whose exact content it has checked this way.**
6. The claims are verified (§1, §2) in the same call.

**Veto window.** Until `veto_secs` have passed, either of these stops the request:

- **any single guardian** calls `veto(request_id)`
- the council reaches its normal reject threshold in Sputnik or Trezu

Sputnik only rejects on a threshold, which is why the lane has its own single-guardian veto.

**Execute.** After the window, **anyone** may call `execute(request_id)`. The lane checks that the request wasn't vetoed and the proposal is still `InProgress`, then votes `VoteApprove`. Its 1/1 role threshold approves it, and Sputnik pays from the treasury.

**Refunds.** If a registration fails its checks, or a request is vetoed, rejected or expires, its amount is credited back to both limits. Bonds never touch the lane: Sputnik returns them to `C` as the proposer, under its normal rules.

**The lane never:**
- votes on a proposal that wasn't registered and checked as above. Its `transfer:VoteApprove` permission would otherwise let it approve any transfer in the DAO, so this is tested explicitly.
- holds funds.
- has a full-access key after deployment.
- changes its own config. Only the DAO can, through a proposal.

**Worst case.** If every check failed at once, the most the lane can move is `period_budget` per period, every request is visible as an ordinary proposal during its veto window, and the DAO can remove the role with one proposal.

## 4. Off-chain records (discovery and simulation only)

The crawler reads mainnet DAOs with free view calls (`get_dao_list`, `get_last_proposal_id`, `get_proposals`, `get_policy`), throttled to stay under public RPC rate limits. It builds:

- **Claim discovery:** for any account, which proposals would be valid claims, so a contributor doesn't have to find them by hand.
- **The simulator:** for a chosen DAO and config, it replays that DAO's history and reports how many past payouts would have qualified for the lane, the votes saved, and the largest possible exposure per period.

Off-chain data is **never trusted for money**. The contracts re-read every claim on-chain.

## 5. Privacy

- Claims are presented by the contributor; nothing is listed for an account that didn't present it.
- The simulator shows aggregates per DAO (counts, totals, exposure), not rankings of people.
- No leaderboard. Rejected proposals are never shown per person.

## 6. Coverage: what counts and what doesn't

| Payout path | Counted on-chain (v1) | Read by the off-chain records |
| --- | --- | --- |
| `Transfer` proposal | Yes | Yes |
| `BountyDone` proposal | No (planned) | Yes |
| `FunctionCall` → `ft_transfer` on a token contract | No | Yes |
| Trezu bulk payments (`bulkpayment.near approve_list`) | No | Yes, by joining with `view_list` |
| Confidential payouts (NEAR Intents confidential mode) | No | No, private by design |

## 7. What gaming costs

| Attack | What stops it |
| --- | --- |
| Create a ring of DAOs that pay each other | Untrusted DAOs count for nothing (rule 2) |
| A trusted DAO pays you 1 yocto many times | `min_amount` (rule 7) |
| Many payouts from one friendly trusted DAO | `min_distinct_daos` |
| A council pays its own members to farm records | `exclude_members` (rule 9) |
| Present someone else's payouts | `receiver_id == C` (rule 5) |
| Repeat the same claim in one request | Rule 8 |
| Replay a request | `(C, nonce)` is single-use, and each proposal can be registered once |
| Spam junk registrations to drain the lane's storage balance | Every registration pays a storage deposit (about 3× the bytes a request uses) |
| Register someone else's proposal, or one paying someone else | `proposer == receiver_id == C` |
| Change the amount after registering | Sputnik proposals are immutable; the lane checks the exact amount |
| Many qualifying accounts drain the lane | `period_budget` per period, debited before the call |
| A colluding member of a trusted DAO | Bounded by `per_account_cap`, `period_budget` and the veto window |
| A bug makes the lane approve other proposals | It only votes on proposals registered and checked field by field; tested; no full-access key |
| Stale or forged off-chain data | The contracts re-read every claim on-chain |
| A trusted DAO upgrades itself to code that fakes `get_proposal` | Not preventable on-chain (§8). Bounded by `per_account_cap`, `period_budget` and the veto window; flagged off-chain before anyone trusts the DAO |

## 8. Trust assumption: trusted DAOs keep running Sputnik

A Sputnik DAO can replace its own code through an `UpgradeSelf` proposal. A NEAR contract cannot read another account's code hash, so neither the verifier nor the lane can check, on-chain, that a trusted DAO still runs Sputnik.

That is why trust is explicit (rule 2). A funding DAO trusts a DAO's **council**. A council that installs code which fakes approved payouts could equally approve real payouts to its friends; custom code only makes that cheaper. Either way the damage is bounded by the lane's limits and veto.

Off-chain, every DAO's code hash is checked against the versions the factory publishes (`sputnik-dao.near.get_contracts_metadata`):

- the crawler records each DAO's code hash
- the snapshot labels each DAO with its Sputnik version, `none` (no contract), or `custom`
- the CLI and the web app warn before a `custom` or `none` DAO is trusted

The 2026-11-10 crawl found 10 factory DAOs that no longer answer `get_proposal` at all.
