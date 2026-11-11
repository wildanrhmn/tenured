//! Track Record verifier.
//!
//! Checks a contributor's claims against the paying DAOs' own proposals,
//! read live with `get_proposal`. No admin, no owner and no stored records:
//! the only state is which Sputnik factory counts, fixed at deploy time.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use track_record_rules::{check_proposal, static_checks, summarize, Claim, Reject, Rules, Summary};

/// One cross-contract call per claim; kept well under the 300 Tgas limit.
pub const MAX_CLAIMS: usize = 10;
const GAS_PER_READ: Gas = Gas::from_tgas(8);
const GAS_CALLBACK: Gas = Gas::from_tgas(20);

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
        let reads: Vec<Promise> = claims
            .iter()
            .zip(&statics)
            .filter(|(_, verdict)| verdict.is_none())
            .map(|(c, _)| read_proposal(c))
            .collect();

        let Some(joined) = reads.into_iter().reduce(Promise::and) else {
            return PromiseOrValue::Value(attest(account_id, &claims, &statics, &[], &rules));
        };
        joined
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
        let raws = read_results(statics.iter().filter(|v| v.is_none()).count());
        attest(account_id, &claims, &statics, &raws, &rules)
    }
}

/// Static rules plus "is this even a valid account id", so a malformed
/// name can't make the cross-contract call panic.
pub fn pre_checks(claims: &[Claim], rules: &Rules, factory: &str) -> Vec<Option<Reject>> {
    static_checks(claims, rules, factory)
        .into_iter()
        .zip(claims)
        .map(|(verdict, c)| verdict.or_else(|| c.dao_id.parse::<AccountId>().err().map(|_| Reject::NotFactoryDao)))
        .collect()
}

pub fn read_proposal(c: &Claim) -> Promise {
    let dao: AccountId = c.dao_id.parse().expect("checked in pre_checks");
    Promise::new(dao).function_call(
        "get_proposal".to_string(),
        json!({ "id": c.proposal_id }).to_string().into_bytes(),
        NearToken::from_yoctonear(0),
        GAS_PER_READ,
    )
}

/// Largest `get_proposal` response we read. Bounding it stops a hostile
/// DAO from burning the callback's gas with an enormous description.
pub const MAX_PROPOSAL_BYTES: usize = 64 * 1024;

/// Results of the joined reads, in order. A failed call (for example
/// `ERR_NO_PROPOSAL`), an oversized response or an unparsable body comes
/// back as `None`.
pub fn read_results(n: usize) -> Vec<Option<Value>> {
    (0..n as u64)
        .map(|i| {
            env::promise_result_checked(i, MAX_PROPOSAL_BYTES)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        })
        .collect()
}

/// Combines static verdicts with the proposals read for the remaining claims.
pub fn attest(
    account_id: AccountId,
    claims: &[Claim],
    statics: &[Option<Reject>],
    raws: &[Option<Value>],
    rules: &Rules,
) -> Attestation {
    let mut raws = raws.iter();
    let results: Vec<ClaimResult> = claims
        .iter()
        .zip(statics)
        .map(|(c, verdict)| {
            let reason = match verdict {
                Some(r) => Some(*r),
                None => check_proposal(raws.next().and_then(|v| v.as_ref()), account_id.as_str(), rules).err(),
            };
            ClaimResult { dao_id: c.dao_id.clone(), proposal_id: c.proposal_id, ok: reason.is_none(), reason }
        })
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
