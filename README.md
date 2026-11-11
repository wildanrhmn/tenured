# Track Record

Portable, verifiable contributor history for Sputnik DAOs on NEAR.

When someone has already been paid for work by other DAOs, a new DAO can check that on-chain by reading those DAOs' own proposals. There is no oracle and no score server. A DAO can then pre-approve small payouts for proven contributors, while its council keeps a veto.

> Work in progress for NEAR HACKATHON (November 2026). This README is filled in as the pieces land.

## Repository layout

| Path | What it is |
| --- | --- |
| `RULES.md` | The rules: what counts as a past payout, who qualifies, how the fast lane limits and vetoes payouts |
| `contracts/` | Rust smart contracts (`verifier`, `lane`) |
| `offchain/` | Crawler, rules engine, simulator and CLI (TypeScript) |
| `web/` | Web app |

## License

MIT
