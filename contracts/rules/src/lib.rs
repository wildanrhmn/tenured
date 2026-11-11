//! Claim checks from RULES.md §1 and §2.
//!
//! Plain Rust with no NEAR dependencies, so the same code runs inside both
//! contracts and in native unit tests. The off-chain TypeScript engine is
//! held to the same behaviour by the shared cases in `fixtures/claims.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A pointer to one past proposal, presented by the contributor.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub dao_id: String,
    pub proposal_id: u64,
}

/// A payout token that counts, and the smallest amount that counts.
/// `token_id` is `""` for native NEAR. Amounts are decimal strings in the
/// token's smallest unit, as Sputnik stores them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct TokenFloor {
    pub token_id: String,
    pub min_amount: String,
}

/// What a funding DAO accepts as a track record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Rules {
    pub trusted_daos: Vec<String>,
    pub tokens: Vec<TokenFloor>,
    pub min_distinct_daos: u32,
    pub min_payouts: u32,
}

/// Why a claim didn't count. Names match `fixtures/claims.json`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    NotFactoryDao,
    NotTrusted,
    Duplicate,
    NotFound,
    Unreadable,
    NotApproved,
    NotTransfer,
    WrongReceiver,
    TokenNotCounted,
    BelowFloor,
}

/// A Sputnik `Transfer` proposal, as the contracts need it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub token_id: String,
    pub receiver_id: String,
    pub amount: String,
    pub msg: Option<String>,
}

/// The parts of a Sputnik proposal both contracts read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalView {
    pub proposer: String,
    pub status: String,
    pub submission_time_ns: u64,
    pub transfer: Option<Transfer>,
}

/// Rule 1: only the factory can create `<name>.<factory>`, so a direct
/// sub-account of the factory is guaranteed to run Sputnik.
pub fn is_factory_dao(dao_id: &str, factory: &str) -> bool {
    match dao_id.strip_suffix(factory).and_then(|s| s.strip_suffix('.')) {
        Some(name) => !name.is_empty() && !name.contains('.'),
        None => false,
    }
}

/// Rules 1, 2 and 8, which need no chain reads. Returns one verdict per
/// claim, in order; `None` means "read the proposal and keep checking".
pub fn static_checks(claims: &[Claim], rules: &Rules, factory: &str) -> Vec<Option<Reject>> {
    let mut seen: Vec<&Claim> = Vec::with_capacity(claims.len());
    claims
        .iter()
        .map(|c| {
            let verdict = if !is_factory_dao(&c.dao_id, factory) {
                Some(Reject::NotFactoryDao)
            } else if !rules.trusted_daos.iter().any(|d| d == &c.dao_id) {
                Some(Reject::NotTrusted)
            } else if seen.contains(&c) {
                Some(Reject::Duplicate)
            } else {
                None
            };
            seen.push(c);
            verdict
        })
        .collect()
}

/// Reads the fields we need out of a `get_proposal` JSON response.
pub fn parse_proposal(v: &Value) -> Option<ProposalView> {
    let proposer = v.get("proposer")?.as_str()?.to_string();
    let status = v.get("status")?.as_str()?.to_string();
    let submission_time_ns = match v.get("submission_time")? {
        Value::String(s) => s.parse().ok()?,
        Value::Number(n) => n.as_u64()?,
        _ => return None,
    };
    let transfer = v
        .get("kind")
        .and_then(|k| k.get("Transfer"))
        .and_then(|t| serde_json::from_value::<Transfer>(t.clone()).ok());
    Some(ProposalView { proposer, status, submission_time_ns, transfer })
}

/// Rules 3 to 7 against a proposal read from the paying DAO.
/// `raw` is the `get_proposal` result, or `None` if the call failed.
pub fn check_proposal(raw: Option<&Value>, claimant: &str, rules: &Rules) -> Result<(), Reject> {
    let raw = raw.ok_or(Reject::NotFound)?;
    if raw.is_null() {
        return Err(Reject::NotFound);
    }
    let p = parse_proposal(raw).ok_or(Reject::Unreadable)?;
    if p.status != "Approved" {
        return Err(Reject::NotApproved);
    }
    let t = p.transfer.ok_or(Reject::NotTransfer)?;
    if t.receiver_id != claimant {
        return Err(Reject::WrongReceiver);
    }
    let floor = rules
        .tokens
        .iter()
        .find(|f| f.token_id == t.token_id)
        .ok_or(Reject::TokenNotCounted)?;
    let amount: u128 = t.amount.parse().map_err(|_| Reject::Unreadable)?;
    let min: u128 = floor.min_amount.parse().map_err(|_| Reject::Unreadable)?;
    if amount < min {
        return Err(Reject::BelowFloor);
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub distinct_daos: u32,
    pub payouts: u32,
    pub qualifies: bool,
}

/// §2: count the valid claims and compare them with the bar.
pub fn summarize(valid: &[&Claim], rules: &Rules) -> Summary {
    let mut daos: Vec<&str> = valid.iter().map(|c| c.dao_id.as_str()).collect();
    daos.sort_unstable();
    daos.dedup();
    let distinct_daos = daos.len() as u32;
    let payouts = valid.len() as u32;
    Summary {
        distinct_daos,
        payouts,
        qualifies: distinct_daos >= rules.min_distinct_daos && payouts >= rules.min_payouts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Fixtures {
        factory: String,
        rules: Rules,
        static_cases: Vec<StaticCase>,
        proposal_cases: Vec<ProposalCase>,
        summary_cases: Vec<SummaryCase>,
    }

    #[derive(Deserialize)]
    struct StaticCase {
        name: String,
        claims: Vec<Claim>,
        expect: Vec<Option<Reject>>,
    }

    #[derive(Deserialize)]
    struct ProposalCase {
        name: String,
        claimant: String,
        proposal: Option<Value>,
        expect: Option<Reject>,
    }

    #[derive(Deserialize)]
    struct SummaryCase {
        name: String,
        valid: Vec<Claim>,
        expect: Summary,
    }

    fn fixtures() -> Fixtures {
        let raw = include_str!("../../../fixtures/claims.json");
        serde_json::from_str(raw).expect("fixtures/claims.json parses")
    }

    #[test]
    fn static_cases() {
        let f = fixtures();
        for case in &f.static_cases {
            assert_eq!(static_checks(&case.claims, &f.rules, &f.factory), case.expect, "{}", case.name);
        }
    }

    #[test]
    fn proposal_cases() {
        let f = fixtures();
        for case in &f.proposal_cases {
            let got = check_proposal(case.proposal.as_ref(), &case.claimant, &f.rules).err();
            assert_eq!(got, case.expect, "{}", case.name);
        }
    }

    #[test]
    fn summary_cases() {
        let f = fixtures();
        for case in &f.summary_cases {
            let valid: Vec<&Claim> = case.valid.iter().collect();
            assert_eq!(summarize(&valid, &f.rules), case.expect, "{}", case.name);
        }
    }

    #[test]
    fn factory_names() {
        assert!(is_factory_dao("marketing.sputnik-dao.near", "sputnik-dao.near"));
        assert!(!is_factory_dao("sputnik-dao.near", "sputnik-dao.near"));
        assert!(!is_factory_dao(".sputnik-dao.near", "sputnik-dao.near"));
        assert!(!is_factory_dao("a.b.sputnik-dao.near", "sputnik-dao.near"));
        assert!(!is_factory_dao("evilsputnik-dao.near", "sputnik-dao.near"));
        assert!(!is_factory_dao("marketing.sputnik-dao.near.evil.near", "sputnik-dao.near"));
    }
}
