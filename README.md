# Tenured

**Your DAO track record, verified on-chain. Proven contributors skip the queue.**

Portable, verifiable contributor history for Sputnik DAOs on NEAR.

A contributor who has already been paid for work by other DAOs can prove it to a new DAO. The new DAO's contract reads those DAOs' own proposals on-chain, so there is no oracle, no score server and no list to trust. A DAO can then let proven contributors' small payouts through a **fast lane**: a Sputnik role that approves them after a veto window, paid from the DAO's own treasury.

Built at NEAR HACKATHON (November 2026). Tracks: `social` (Social Money), `security`, `agents`.

## The problem

On NEAR every DAO payout is a proposal that a council must vote on, and every DAO starts from zero with every contributor. Trust earned in one community never carries to the next, even though the evidence is all public: five years of approved payouts sit in Sputnik DAO contracts on mainnet.

Other entries in this hackathon build trust tiers *inside* one DAO. Tenured is the record that travels between DAOs, verified straight from the chain.

## What's in it

| Part | What it does | Where |
| --- | --- | --- |
| `verifier` contract | Given an account and claims `(dao, proposal_id)`, reads each proposal from the paying DAO and checks it was an approved payout to that account, from a DAO the caller trusts, above a floor. Stateless, no admin | `contracts/verifier` |
| `lane` contract | A Sputnik role member that holds **no funds** and has exactly one permission, `transfer:VoteApprove`. Approves a contributor's own Transfer proposal after checking it field by field, verifying their track record, debiting caps and waiting out a veto window | `contracts/lane` |
| Mainnet dataset | Every one of the 2,115 DAOs on `sputnik-dao.near`, crawled with free view calls: 33,126 payouts across five payout paths | `data/mainnet` |
| Simulator | Replays a real DAO's history as if the lane had been installed: how many payouts would have skipped a vote, council votes saved, the most money exposed in any period | `offchain/src/simulate.ts` |
| CLI | Claim discovery, **live verification against mainnet** with the same rules as the contract, the simulator | `offchain/src/cli.ts` |
| Web app | All of the above in a browser, plus a live view of the testnet lane and an install wizard | `web/` |

The full specification, including the threat model and its limits, is [RULES.md](RULES.md).

## Try it

Everything below needs no keys and no funds.

### 1. One-command check (about 30 s)

```sh
npm ci
npm run judge
```

You should see 7 checks marked `[ok]`, ending with `judge: 7 checks, 0 failed`:

- the published numbers reproduce from the committed snapshot
- the TypeScript and Rust rule implementations agree on the shared fixtures
- sampled snapshot payouts are identical to what mainnet returns right now
- on testnet, the lane is a DAO role with exactly one permission, and the demo contributor's record verifies against the DAOs

`npm run judge -- --offline` runs only the offline checks.

### 2. Simulate the lane on a real mainnet DAO

```sh
npm run cli -- simulate nearweek-news-contribution.sputnik-dao.near --token near --cap 500 --budget 2000
```

You should see that of the 4,907 NEAR payouts this DAO made to news contributors, **1,645 would have skipped a council vote (2,069 votes saved)**. You'll also see how many were stopped by the cap or the budget, and the most the lane would ever have moved in one 30-day period. The output is aggregate only.

Grant DAOs come out lower: `open-web-academy` 37% of its NEAR payouts, `orderly-ops` 21%, `marketing` 4%. The lane helps most where the same people are paid again and again.

### 3. Verify a record live

```sh
npm run cli -- verify trackrecord-dev.testnet --network testnet \
  --trust trackrecord-alpha.sputnikv2.testnet,trackrecord-beta.sputnikv2.testnet \
  --claims 'trackrecord-alpha.sputnikv2.testnet#0,trackrecord-alpha.sputnikv2.testnet#1,trackrecord-beta.sputnikv2.testnet#0' \
  --min-near 0.1
```

You should see each claimed proposal read live from its DAO and marked `ok`, the result `3 valid payouts from 2 DAOs: qualifies`, and the Sputnik code version of each paying DAO. Use `--network mainnet` (the default) with your own account and `--trust-like <a DAO you worked for>` to check a real record.

### 4. Run the contract tests

```sh
./scripts/build-contracts.sh
cd contracts && cargo test
```

Needs Rust and [`cargo-near`](https://github.com/near/cargo-near). You should see 29 unit tests (rules, verifier, lane), then **14 sandbox tests** that run a local NEAR node with the exact Sputnik code the testnet factory deploys (`contracts/res/sputnikdao2.wasm`; its sha256 equals `sputnikv2.testnet.get_default_code_hash()`).

The sandbox tests cover:

- **The happy path:** payout after the veto window; the verifier's attestations.
- **Stopping a request:** a single guardian's veto; a council rejection during the window; the DAO removing the lane's role.
- **Proposals and limits:** proposals that aren't exactly yours; caps, nonces and double registration; someone squatting your proposal ID.
- **Edge cases:** a vote that doesn't approve; a veto window longer than the proposal (the bond stays recoverable); councils paying themselves.
- **Costs:** storage paid by callers; the worst case of 9 claims from 9 DAOs; the largest inputs the size limits allow (172 Tgas).

The Rust and TypeScript rule implementations are also **fuzzed against each other**. `fixtures/random-claims.json` holds 5,000 random and nearly-valid claims plus 300 static cases. Rust checks every TypeScript verdict, and a TypeScript test checks the file still matches its generator.

### 5. Watch it on testnet

The testnet accounts carry the project's working name, `trackrecord-*`.

| Account | Role |
| --- | --- |
| [`trackrecord-lane.testnet`](https://testnet.nearblocks.io/address/trackrecord-lane.testnet) | The lane contract |
| [`trackrecord-verifier.testnet`](https://testnet.nearblocks.io/address/trackrecord-verifier.testnet) | The verifier contract |
| [`trackrecord-fund.sputnikv2.testnet`](https://testnet.nearblocks.io/address/trackrecord-fund.sputnikv2.testnet) | The DAO that installed the lane |
| [`trackrecord-alpha.sputnikv2.testnet`](https://testnet.nearblocks.io/address/trackrecord-alpha.sputnikv2.testnet), [`trackrecord-beta.sputnikv2.testnet`](https://testnet.nearblocks.io/address/trackrecord-beta.sputnikv2.testnet) | DAOs where the contributor was paid before |

Transactions from the demo run against the current code:

| Step | Transaction |
| --- | --- |
| The verifier attests `trackrecord-dev.testnet` (3 payouts from 2 DAOs, members excluded); the `verified` event carries the rules hash | [`ECzBrwtb…`](https://testnet.nearblocks.io/txns/ECzBrwtb3SSPxPdkqBeAQ6chBzTYx3pK6UoakLJ1uA1f) |
| The contributor registers a 0.1 NEAR proposal with the lane | [`8wNfnRUM…`](https://testnet.nearblocks.io/txns/8wNfnRUMj3VDcBZu9NhQufjPT1Up8ASZv4o34U6ggrQ9) |
| `execute` before the veto window closes is rejected | [`2dZ2cbTz…`](https://testnet.nearblocks.io/txns/2dZ2cbTz8N4qeZs2PknwLVerZFtHdyXgBGyrQMj4fDLD) |
| After the window: the lane votes, and the DAO approves and pays from its treasury | [`kMA2pTPf…`](https://testnet.nearblocks.io/txns/kMA2pTPf5izkTdn4Ax4cLqT5hatPohkEzVo8mKLajvb) |
| A guardian vetoes another request on their own | [`GFqgveXF…`](https://testnet.nearblocks.io/txns/GFqgveXFyJzhdMcEVYQjXsJLEPgqrL9PanjBLwuMWgDk) |
| An account presenting someone else's payouts is refused | [`QyYsnaj5…`](https://testnet.nearblocks.io/txns/QyYsnaj51SaPct2YDqNtZQjMC1Q4TjJnBqe4VXevE3m) |
| The DAO changes the lane's config through an ordinary proposal | [`kfgHt7RJ…`](https://testnet.nearblocks.io/txns/kfgHt7RJekFWVUkJwuJZQ1YwX9tQSjEbLEqr2cqAc8c) |
| Anyone else calling `configure` is rejected | [`soSzfHYV…`](https://testnet.nearblocks.io/txns/soSzfHYVAqzeVzGPr9jABhKhZZa7dYQHpJnrekpVkfX) |
| A registration without the storage deposit is rejected | [`4oHmVpfC…`](https://testnet.nearblocks.io/txns/4oHmVpfCRXTtA9bBJaPZrXQz7z8AmaMkQhcSh22oSbqh) |

To run the whole thing yourself on testnet with free faucet accounts, read [`scripts/testnet-setup.sh`](scripts/testnet-setup.sh) and [`scripts/testnet-demo.sh`](scripts/testnet-demo.sh); `PREFIX=yourname` gives you your own copies.

### 6. Use it from an AI agent (MCP)

AI agents increasingly do paid work for DAOs. `offchain/src/mcp.ts` is an MCP server, so an agent can use its own track record. Add it to any MCP client:

```json
{ "mcpServers": { "tenured": { "command": "npm", "args": ["run", "-s", "mcp"], "cwd": "/path/to/this/repo" } } }
```

| Tool | What it does |
| --- | --- |
| `find_claims` | The best payouts an account can present, from the snapshot |
| `verify_record` | Live verification with the contract's rules, plus each paying DAO's code version |
| `simulate_dao` | The simulator (aggregates only) |
| `plan_lane_request` | Scans the lane's trusted DAOs live for the account's payouts, verifies them, reads the DAO's bond, and returns the two transactions to sign (`add_proposal`, then `register`) with near CLI commands |

The server never holds keys. The agent signs the plan with its own wallet, for example through [nearai/near-mcp](https://github.com/nearai/near-mcp). `npm test` includes a test that drives the server over stdio.

### 7. Use the web app

```sh
npm ci
npm run web:dev       # http://localhost:5173
npm run web:build     # static site in web/dist
```

The app imports the same rules engine as the CLI from `offchain/src` and loads `data/mainnet/snapshot.json.gz` in the browser. It needs no backend and no keys.

| Page | What it does |
| --- | --- |
| Overview | The idea, the mainnet numbers from `report.json`, and the steps of a fast-lane payout |
| Try it on your DAO | The simulator on any crawled DAO: pick the pay token, caps, budget, bar and trusted DAOs, and optionally exclude payouts to members. Totals and a per-period chart only |
| Check a record | Finds an account's claims in the snapshot, then verifies each one live on mainnet with the verifier's rules, and shows each paying DAO's code version with any warning |
| Live lane | Reads the testnet lane, its config and requests (with veto and expiry countdowns), and the fund DAO's policy. Copyable near CLI commands for each step of the demo |
| Install | A form that writes the lane's init arguments, the `fastlane` role proposal and the near CLI commands, checked against the lane's `validate()` |

To host it under a sub-path, for example on GitHub Pages, build with `VITE_BASE=/repo-name/ npm run web:build`.

## How it works

```
 contributor                      lane (role member, no funds)            paying DAOs        funding DAO
 -----------                      ----------------------------            -----------        -----------
 1. add_proposal(Transfer to me) ------------------------------------------------------------>  #N InProgress
 2. register(N, amount, claims) -> debit cap + budget
                                   read #N from funding DAO  <--------------------------------  exact match?
                                   read each claim           <------------ get_proposal(id)
                                   qualifies? -> Waiting until now + veto_secs
 3. (veto window)                  any guardian: veto(id)      council: VoteReject (native)
 4. anyone: execute(id)       ->   act_proposal(N, VoteApprove) ---------------------------->  1/1 role -> Approved
                                   read #N back: Approved? else refuse + credit limits back     treasury pays
```

What the lane will never do:

- vote on a proposal that wasn't registered and checked field by field
- hold money
- change its own config (only the DAO can, through a proposal)

The worst case is `period_budget` per period, with every request visible during its veto window. RULES.md §7 is the full table of attacks and what stops each one.

## What the mainnet data shows

Every number comes from `data/mainnet/report.json`, which `npm run reproduce` rebuilds from the committed snapshot.

- **2,115 DAOs** on `sputnik-dao.near`; 1,651 ever made a proposal, 711 ever paid someone.
- **9 run code the factory never published, and 10 no longer answer `get_proposal`.** The rest run Sputnik v2.0 to v3.2, 778 of them through NEP-591 global contracts. This is why trusted DAOs are checked off-chain (RULES.md §8).
- **33,126 payouts to 6,450 accounts.**
  - 6.4% are invisible to a crawl that only reads `Transfer` proposals (bounties, `ft_transfer` calls, NEAR Intents transfers, Trezu bulk lists).
  - 2,223 more went out through chain signatures, whose recipients can't be read from the proposal. These are reported, not guessed.
- **1,048 accounts can already present payouts from two or more DAOs**, and 489 were paid by three or more. They qualify on day one, with no sign-up.
- **60% of payouts were filed by the person who got paid.** That is exactly the lane's flow, so it matches how DAOs already work.

## Security review

An independent review of the contracts found the issues below. Each one is fixed and has a sandbox test, or was refuted by measurement.

| Finding | Severity | Outcome |
| --- | --- | --- |
| Anyone could reserve any proposal id and block its real proposer | High | Fixed: registrations are unique per account |
| The lane paid for every registration's storage, so junk registrations could drain it | Medium | Fixed: registration pays 0.01 NEAR |
| Worst-case reads might exceed 300 Tgas | Medium | Refuted: 55 Tgas worst case, 172 Tgas at the size limits |
| Huge proposals or policies could starve the callback of gas | Medium | Fixed: 16 KB / 32 KB caps sized from mainnet data; stuck checks release after 10 min |
| Voting after expiry locks the contributor's bond (a Sputnik quirk) | Low | Fixed: the lane reads the proposal period and never votes near expiry |
| A refund while the lane's vote still stood could let a payout escape the budget | Low | Fixed: new `Voted` state keeps the amount counted |
| `recheck` could race an in-flight vote; missing config bounds; `u32` id aliasing | Low | Fixed |
| An attestation didn't say which rules it used | Low | Fixed: `rules_hash` in attestations and events |
| Payouts through `ft_transfer_call` (`msg`) can be refunded by the receiver | Info | Fixed: they don't count |

Fuzzing the two rule implementations then found 246 disagreements in number parsing (`"+5"`, values past `u64`/`u128`). Both sides now accept canonical decimals only.

## Trust model, honestly

- **Off-chain data is never trusted for money.** The snapshot only helps contributors find their claims and powers the simulator; the contracts re-read every claim on-chain.
- **Trust is relative.** Payouts count only from DAOs the funding DAO lists. A ring of self-made DAOs earns nothing.
- **Self-payment can be excluded.** 30.7% of mainnet payouts go to current members of the paying DAO. With `exclude_members`, the contracts read each paying DAO's policy and don't count those (RULES.md rule 9).
- **A trusted DAO could upgrade its own code to fake history** (Sputnik allows `UpgradeSelf`). NEAR contracts can't read another account's code hash, so this can't be checked on-chain (RULES.md §8).
  - It is bounded by the lane's cap, budget and veto.
  - It is checked off-chain: the CLI and web app compare each DAO's code hash with the versions `sputnik-dao.near` publishes.
- **Only `Transfer` payouts are claimable on-chain in v1.** Other paths feed the simulator and the coverage report.
- **Contracts run on testnet.** Mainnet is used read-only (free view calls). Deploying to mainnet is the same `near contract deploy` command.

## NEAR features used

| Feature | Why it's needed |
| --- | --- |
| Sputnik DAO roles and policy | The lane is a 1/1 role with only `transfer:VoteApprove`; installing it is one ordinary `ChangePolicyAddOrUpdateRole` proposal, visible in Trezu like any other |
| Cross-contract calls and promise joins | One `register` reads the proposal and up to 9 claims from other DAOs in parallel (14 Tgas for 3 claims) |
| Named accounts and the factory namespace | Only `sputnik-dao.near` can create `x.sputnik-dao.near`, which is how a claim's DAO is identified without a registry |
| NEP-297 events | `verified`, `registered`, `vetoed`, `approved`, `refused` for indexers |
| Free view calls | The whole mainnet history, crawled without an indexer |

## Repository

```
RULES.md                  the specification
contracts/rules           claim rules shared by both contracts (plain Rust)
contracts/verifier        verifier contract
contracts/lane            fast lane contract
contracts/integration     sandbox tests against the real sputnikdao2 code
contracts/res             sputnikdao2.wasm and its provenance
fixtures/claims.json      shared test cases for the Rust and TypeScript rules
offchain/                 crawler, snapshot, report, simulator, CLI, judge
data/mainnet/             snapshot.json.gz (0.8 MB) and report.json
scripts/                  build, testnet setup and demo
web/                      web app
```

## License

MIT
