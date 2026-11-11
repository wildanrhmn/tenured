//! Track Record verifier.
//!
//! Checks a contributor's claims against the paying DAOs' own proposals,
//! read live with `get_proposal`. No admin, no owner and no stored records:
//! the only state is which Sputnik factory counts, fixed at deploy time.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, log, near, require, AccountId, Gas, Promise, PromiseOrValue};
use track_record_rules::chain::{pre_checks, read_claims, read_results, verdicts};
use track_record_rules::{summarize, Claim, Reject, Rules, Summary};

/// One cross-contract read per claim; kept well under the 300 Tgas limit.
pub const MAX_CLAIMS: usize = 10;
const GAS_CALLBACK: Gas = Gas::from_tgas(30);

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimResult {
    pub dao_id: String,
    pub proposal_id: u64,
    pub ok: bool,
    pub reason: Option<Reject>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Attestation {
    pub account_id: AccountId,
    pub results: Vec<ClaimResult>,
    pub summary: Summary,
}

#[near(contract_state)]
#[derive(near_sdk::PanicOnDefault)]
pub struct Verifier {
    factory: AccountId,
}

#[near]
impl Verifier {
    #[init]
    pub fn new(factory: AccountId) -> Self {
        Self { factory }
    }

    pub fn factory(&self) -> AccountId {
        self.factory.clone()
    }

    /// Verifies `claims` for `account_id` under `rules` and returns an
    /// attestation. Anyone can call it for anyone: it only reads public data.
    pub fn verify(&self, account_id: AccountId, claims: Vec<Claim>, rules: Rules) -> PromiseOrValue<Attestation> {
        require!(!claims.is_empty(), "no claims");
        require!(claims.len() <= MAX_CLAIMS, "too many claims");

        let statics = pre_checks(&claims, &rules, self.factory.as_str());
        let Some(reads) = read_claims(&claims, &statics).into_iter().reduce(Promise::and) else {
            return PromiseOrValue::Value(attest(account_id, &claims, &statics, &[], &rules));
        };
        reads
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_read(account_id, claims, statics, rules),
            )
            .into()
    }

    #[private]
    pub fn on_read(
        &self,
        account_id: AccountId,
        claims: Vec<Claim>,
        statics: Vec<Option<Reject>>,
        rules: Rules,
    ) -> Attestation {
        let raws = read_results(0, statics.iter().filter(|v| v.is_none()).count());
        attest(account_id, &claims, &statics, &raws, &rules)
    }
}

/// Combines static verdicts with the proposals read for the remaining claims.
pub fn attest(
    account_id: AccountId,
    claims: &[Claim],
    statics: &[Option<Reject>],
    raws: &[Option<Value>],
    rules: &Rules,
) -> Attestation {
    let results: Vec<ClaimResult> = claims
        .iter()
        .zip(verdicts(account_id.as_str(), statics, raws, rules))
        .map(|(c, reason)| ClaimResult { dao_id: c.dao_id.clone(), proposal_id: c.proposal_id, ok: reason.is_none(), reason })
        .collect();

    let valid: Vec<&Claim> = claims.iter().zip(&results).filter(|(_, r)| r.ok).map(|(c, _)| c).collect();
    let summary = summarize(&valid, rules);
    log!(
        "EVENT_JSON:{}",
        json!({
            "standard": "track_record",
            "version": "1.0.0",
            "event": "verified",
            "data": [{
                "account_id": account_id,
                "distinct_daos": summary.distinct_daos,
                "payouts": summary.payouts,
                "qualifies": summary.qualifies,
            }]
        })
    );
    Attestation { account_id, results, summary }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        Rules {
            trusted_daos: vec!["a.sputnikv2.testnet".into(), "b.sputnikv2.testnet".into()],
            tokens: vec![track_record_rules::TokenFloor { token_id: "".into(), min_amount: "10".into() }],
            min_distinct_daos: 2,
            min_payouts: 2,
        }
    }

    fn approved(receiver: &str, amount: &str) -> Value {
        json!({
            "id": 0, "proposer": "x.testnet", "description": "",
            "kind": { "Transfer": { "token_id": "", "receiver_id": receiver, "amount": amount, "msg": null } },
            "status": "Approved", "vote_counts": {}, "votes": {}, "submission_time": "1"
        })
    }

    #[test]
    fn malformed_dao_name_is_rejected_before_any_call() {
        let claims = vec![Claim { dao_id: "BAD NAME.sputnikv2.testnet".into(), proposal_id: 1 }];
        let mut r = rules();
        r.trusted_daos.push("BAD NAME.sputnikv2.testnet".into());
        assert_eq!(pre_checks(&claims, &r, "sputnikv2.testnet"), vec![Some(Reject::NotFactoryDao)]);
    }

    #[test]
    fn attestation_lines_up_reads_with_claims() {
        let claims = vec![
            Claim { dao_id: "a.sputnikv2.testnet".into(), proposal_id: 1 },
            Claim { dao_id: "ring.sputnikv2.testnet".into(), proposal_id: 1 },
            Claim { dao_id: "b.sputnikv2.testnet".into(), proposal_id: 2 },
        ];
        let statics = pre_checks(&claims, &rules(), "sputnikv2.testnet");
        assert_eq!(statics, vec![None, Some(Reject::NotTrusted), None]);
        let raws = vec![Some(approved("dev.testnet", "50")), Some(approved("dev.testnet", "50"))];
        let a = attest("dev.testnet".parse().unwrap(), &claims, &statics, &raws, &rules());
        assert_eq!(a.results.iter().map(|r| r.ok).collect::<Vec<_>>(), vec![true, false, true]);
        assert_eq!(a.summary, Summary { distinct_daos: 2, payouts: 2, qualifies: true });
    }

    #[test]
    fn a_failed_read_counts_as_not_found() {
        let claims = vec![Claim { dao_id: "a.sputnikv2.testnet".into(), proposal_id: 99 }];
        let statics = pre_checks(&claims, &rules(), "sputnikv2.testnet");
        let a = attest("dev.testnet".parse().unwrap(), &claims, &statics, &[None], &rules());
        assert_eq!(a.results[0].reason, Some(Reject::NotFound));
        assert!(!a.summary.qualifies);
    }
}
