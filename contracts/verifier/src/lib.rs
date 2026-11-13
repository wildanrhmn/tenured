//! Track Record verifier.
//!
//! Checks a contributor's claims against the paying DAOs' own proposals,
//! read live with `get_proposal`. No admin, no owner and no stored records:
//! the only state is which Sputnik factory counts, fixed at deploy time.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, log, near, require, AccountId, Gas, Promise, PromiseOrValue};
use track_record_rules::chain::{policy_daos, pre_checks, read_claims, read_policy, read_results, verdicts, MAX_POLICY_BYTES, MAX_PROPOSAL_BYTES};
use track_record_rules::{summarize, Claim, Reject, Rules, Summary};

/// One read per claim, plus one per paying DAO when members are excluded;
/// kept well under the 300 Tgas limit.
pub const MAX_CLAIMS: usize = 10;
const GAS_CALLBACK: Gas = Gas::from_tgas(70);

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
    /// sha256 of the rules as JSON. Anyone can call `verify` with any rules,
    /// so an attestation only means something for the rules it names.
    pub rules_hash: String,
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
        let daos = policy_daos(&claims, &statics, &rules);
        let reads = read_claims(&claims, &statics).into_iter().chain(daos.iter().map(|d| read_policy(d)));
        let Some(reads) = reads.reduce(Promise::and) else {
            return PromiseOrValue::Value(attest(account_id, &claims, &statics, &[], &[], &[], &rules));
        };
        reads
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_read(account_id, claims, statics, daos, rules),
            )
            .into()
    }

    #[private]
    pub fn on_read(
        &self,
        account_id: AccountId,
        claims: Vec<Claim>,
        statics: Vec<Option<Reject>>,
        policy_daos: Vec<String>,
        rules: Rules,
    ) -> Attestation {
        let n = statics.iter().filter(|v| v.is_none()).count();
        let raws = read_results(0, n, MAX_PROPOSAL_BYTES);
        let policies = read_results(n as u64, policy_daos.len(), MAX_POLICY_BYTES);
        attest(account_id, &claims, &statics, &raws, &policy_daos, &policies, &rules)
    }
}

/// Combines static verdicts with the proposals (and policies) read for the
/// remaining claims.
pub fn attest(
    account_id: AccountId,
    claims: &[Claim],
    statics: &[Option<Reject>],
    raws: &[Option<Value>],
    policy_daos: &[String],
    policies: &[Option<Value>],
    rules: &Rules,
) -> Attestation {
    let results: Vec<ClaimResult> = claims
        .iter()
        .zip(verdicts(account_id.as_str(), claims, statics, raws, policy_daos, policies, rules))
        .map(|(c, reason)| ClaimResult { dao_id: c.dao_id.clone(), proposal_id: c.proposal_id, ok: reason.is_none(), reason })
        .collect();

    let valid: Vec<&Claim> = claims.iter().zip(&results).filter(|(_, r)| r.ok).map(|(c, _)| c).collect();
    let summary = summarize(&valid, rules);
    let rules_hash = rules_hash(rules);
    log!(
        "EVENT_JSON:{}",
        json!({
            "standard": "track_record",
            "version": "1.0.0",
            "event": "verified",
            "data": [{
                "account_id": account_id,
                "rules_hash": rules_hash,
                "distinct_daos": summary.distinct_daos,
                "payouts": summary.payouts,
                "qualifies": summary.qualifies,
            }]
        })
    );
    Attestation { account_id, rules_hash, results, summary }
}

/// Hex sha256 of the rules' JSON encoding (fields in declaration order).
pub fn rules_hash(rules: &Rules) -> String {
    let bytes = near_sdk::serde_json::to_vec(rules).expect("rules serialize");
    env::sha256(&bytes).iter().map(|b| format!("{b:02x}")).collect()
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
            exclude_members: false,
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
        let a = attest("dev.testnet".parse().unwrap(), &claims, &statics, &raws, &[], &[], &rules());
        assert_eq!(a.results.iter().map(|r| r.ok).collect::<Vec<_>>(), vec![true, false, true]);
        assert_eq!(a.summary, Summary { distinct_daos: 2, payouts: 2, qualifies: true });
    }

    #[test]
    fn members_are_excluded_when_asked() {
        let claims = vec![
            Claim { dao_id: "a.sputnikv2.testnet".into(), proposal_id: 1 },
            Claim { dao_id: "b.sputnikv2.testnet".into(), proposal_id: 2 },
        ];
        let rules = Rules { exclude_members: true, ..rules() };
        let statics = pre_checks(&claims, &rules, "sputnikv2.testnet");
        let daos = policy_daos(&claims, &statics, &rules);
        assert_eq!(daos, vec!["a.sputnikv2.testnet".to_string(), "b.sputnikv2.testnet".to_string()]);
        let raws = vec![Some(approved("dev.testnet", "50")), Some(approved("dev.testnet", "50"))];
        let council = json!({ "roles": [{ "name": "council", "kind": { "Group": ["dev.testnet"] } }] });
        let outsider = json!({ "roles": [{ "name": "council", "kind": { "Group": ["boss.testnet"] } }] });
        let a = attest("dev.testnet".parse().unwrap(), &claims, &statics, &raws, &daos, &[Some(council), Some(outsider)], &rules);
        assert_eq!(a.results[0].reason, Some(Reject::DaoMember));
        assert!(a.results[1].ok);
        assert!(!a.summary.qualifies);
    }

    #[test]
    fn a_failed_read_counts_as_not_found() {
        let claims = vec![Claim { dao_id: "a.sputnikv2.testnet".into(), proposal_id: 99 }];
        let statics = pre_checks(&claims, &rules(), "sputnikv2.testnet");
        let a = attest("dev.testnet".parse().unwrap(), &claims, &statics, &[None], &[], &[], &rules());
        assert_eq!(a.results[0].reason, Some(Reject::NotFound));
        assert!(!a.summary.qualifies);
    }
}
