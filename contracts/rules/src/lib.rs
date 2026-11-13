//! Claim checks from RULES.md §1 and §2.
//!
//! Plain Rust with no NEAR dependencies, so the same code runs inside both
//! contracts and in native unit tests. The off-chain TypeScript engine is
//! held to the same behaviour by the shared cases in `fixtures/claims.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A pointer to one past proposal, presented by the contributor.
#[cfg_attr(feature = "near", derive(near_sdk::borsh::BorshSerialize, near_sdk::borsh::BorshDeserialize))]
#[cfg_attr(feature = "near", borsh(crate = "near_sdk::borsh"))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub dao_id: String,
    pub proposal_id: u64,
}

/// A payout token that counts, and the smallest amount that counts.
/// `token_id` is `""` for native NEAR. Amounts are decimal strings in the
/// token's smallest unit, as Sputnik stores them.
#[cfg_attr(feature = "near", derive(near_sdk::borsh::BorshSerialize, near_sdk::borsh::BorshDeserialize))]
#[cfg_attr(feature = "near", borsh(crate = "near_sdk::borsh"))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct TokenFloor {
    pub token_id: String,
    pub min_amount: String,
}

/// What a funding DAO accepts as a track record.
#[cfg_attr(feature = "near", derive(near_sdk::borsh::BorshSerialize, near_sdk::borsh::BorshDeserialize))]
#[cfg_attr(feature = "near", borsh(crate = "near_sdk::borsh"))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Rules {
    pub trusted_daos: Vec<String>,
    pub tokens: Vec<TokenFloor>,
    pub min_distinct_daos: u32,
    pub min_payouts: u32,
    /// Don't count payouts to members of the paying DAO's group roles
    /// (councils paying themselves). Costs one policy read per paying DAO.
    #[serde(default)]
    pub exclude_members: bool,
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
    /// A Transfer with a `msg` pays through `ft_transfer_call`, and the
    /// receiver can hand the tokens straight back, so it doesn't count.
    WithMsg,
    WrongReceiver,
    TokenNotCounted,
    BelowFloor,
    /// The receiver is in one of the paying DAO's group roles (or its
    /// policy couldn't be read), and the rules exclude members.
    DaoMember,
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

/// Canonical decimal: ASCII digits only, at least one. Sputnik always writes
/// amounts and timestamps this way; anything else ("+5", " 1", "1e3") comes
/// from code that isn't Sputnik and is treated as unreadable. Overflowing
/// the type also fails.
fn dec_u64(s: &str) -> Option<u64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

fn dec_u128(s: &str) -> Option<u128> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// Reads the fields we need out of a `get_proposal` JSON response.
pub fn parse_proposal(v: &Value) -> Option<ProposalView> {
    let proposer = v.get("proposer")?.as_str()?.to_string();
    let status = v.get("status")?.as_str()?.to_string();
    let submission_time_ns = match v.get("submission_time")? {
        Value::String(s) => dec_u64(s)?,
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
    if t.msg.is_some() {
        return Err(Reject::WithMsg);
    }
    if t.receiver_id != claimant {
        return Err(Reject::WrongReceiver);
    }
    let floor = rules
        .tokens
        .iter()
        .find(|f| f.token_id == t.token_id)
        .ok_or(Reject::TokenNotCounted)?;
    let amount = dec_u128(&t.amount).ok_or(Reject::Unreadable)?;
    let min = dec_u128(&floor.min_amount).ok_or(Reject::Unreadable)?;
    if amount < min {
        return Err(Reject::BelowFloor);
    }
    Ok(())
}

/// Whether `account` is in any `Group` role of a `get_policy` response.
/// Membership is read from the DAO's current policy, not the policy at the
/// time of the payout.
pub fn is_member(policy: &Value, account: &str) -> bool {
    policy
        .get("roles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("kind").and_then(|k| k.get("Group")).and_then(Value::as_array))
        .flatten()
        .any(|m| m.as_str() == Some(account))
}

/// Rule 9 on top of rules 3 to 7: when the rules exclude members, a valid
/// payout to a member of the paying DAO doesn't count. An unreadable policy
/// counts as membership, so a failed read can only ever reject.
pub fn check_claim(raw: Option<&Value>, policy: Option<&Value>, claimant: &str, rules: &Rules) -> Result<(), Reject> {
    check_proposal(raw, claimant, rules)?;
    if rules.exclude_members && policy.map_or(true, |p| is_member(p, claimant)) {
        return Err(Reject::DaoMember);
    }
    Ok(())
}

#[cfg_attr(feature = "near", derive(near_sdk::borsh::BorshSerialize, near_sdk::borsh::BorshDeserialize))]
#[cfg_attr(feature = "near", borsh(crate = "near_sdk::borsh"))]
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

/// Contract-side helpers shared by the verifier and the lane.
#[cfg(feature = "near")]
pub mod chain {
    use super::*;
    use near_sdk::{env, AccountId, Gas, NearToken, Promise};

    /// Gas for one read. Measured in the sandbox on sputnikdao2: a 15 KB
    /// proposal costs about 3 Tgas and a 28 KB policy (900 members) about
    /// 9 Tgas, both as a whole call. A read that runs out of gas fails, and
    /// a failed read can only reject, so these err on the generous side.
    pub const GAS_PROPOSAL_READ: Gas = Gas::from_tgas(5);
    pub const GAS_POLICY_READ: Gas = Gas::from_tgas(12);

    /// Largest responses we parse. Bounding them stops a hostile DAO from
    /// burning a callback's gas with an enormous description or member list.
    /// On mainnet (2026-11-10) 99% of approved payout proposals are under
    /// 1 KB and the largest is 17 KB; the largest policy is 24 KB. A
    /// response over the limit is treated as unreadable, so it can only
    /// reject.
    pub const MAX_PROPOSAL_BYTES: usize = 16 * 1024;
    pub const MAX_POLICY_BYTES: usize = 32 * 1024;

    /// Static rules plus "is this a valid account id", so a malformed name
    /// can't make the cross-contract call panic.
    pub fn pre_checks(claims: &[Claim], rules: &Rules, factory: &str) -> Vec<Option<Reject>> {
        static_checks(claims, rules, factory)
            .into_iter()
            .zip(claims)
            .map(|(verdict, c)| verdict.or_else(|| c.dao_id.parse::<AccountId>().err().map(|_| Reject::NotFactoryDao)))
            .collect()
    }

    pub fn read_proposal(dao: AccountId, proposal_id: u64) -> Promise {
        Promise::new(dao).function_call(
            "get_proposal".to_string(),
            serde_json::json!({ "id": proposal_id }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_PROPOSAL_READ,
        )
    }

    /// One read per claim that passed `pre_checks`, in order.
    pub fn read_claims(claims: &[Claim], statics: &[Option<Reject>]) -> Vec<Promise> {
        claims
            .iter()
            .zip(statics)
            .filter(|(_, verdict)| verdict.is_none())
            .map(|(c, _)| read_proposal(c.dao_id.parse().expect("checked in pre_checks"), c.proposal_id))
            .collect()
    }

    /// Results `first..first + n` of the joined reads. A failed call (for
    /// example `ERR_NO_PROPOSAL`), a response over `max_bytes` or an
    /// unparsable body comes back as `None`.
    pub fn read_results(first: u64, n: usize, max_bytes: usize) -> Vec<Option<Value>> {
        (first..first + n as u64)
            .map(|i| {
                env::promise_result_checked(i, max_bytes)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            })
            .collect()
    }

    /// DAOs whose policy must be read: the distinct DAOs of claims still
    /// open after `pre_checks`, in first-seen order. Empty unless the rules
    /// exclude members.
    pub fn policy_daos(claims: &[Claim], statics: &[Option<Reject>], rules: &Rules) -> Vec<String> {
        let mut daos: Vec<String> = Vec::new();
        if rules.exclude_members {
            for (c, v) in claims.iter().zip(statics) {
                if v.is_none() && !daos.contains(&c.dao_id) {
                    daos.push(c.dao_id.clone());
                }
            }
        }
        daos
    }

    pub fn read_policy(dao: &str) -> Promise {
        Promise::new(dao.parse().expect("checked in pre_checks")).function_call(
            "get_policy".to_string(),
            b"{}".to_vec(),
            NearToken::from_yoctonear(0),
            GAS_POLICY_READ,
        )
    }

    /// Per-claim verdicts: static ones, then the proposals read for the
    /// rest, then membership against the policies read for `policy_daos`.
    pub fn verdicts(
        claimant: &str,
        claims: &[Claim],
        statics: &[Option<Reject>],
        raws: &[Option<Value>],
        policy_daos: &[String],
        policies: &[Option<Value>],
        rules: &Rules,
    ) -> Vec<Option<Reject>> {
        let mut raws = raws.iter();
        claims
            .iter()
            .zip(statics)
            .map(|(c, verdict)| match verdict {
                Some(r) => Some(*r),
                None => {
                    let policy = policy_daos.iter().position(|d| d == &c.dao_id).and_then(|i| policies.get(i)?.as_ref());
                    check_claim(raws.next().and_then(|v| v.as_ref()), policy, claimant, rules).err()
                }
            })
            .collect()
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
        member_cases: Vec<MemberCase>,
        member_proposal: Value,
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
    struct MemberCase {
        name: String,
        claimant: String,
        exclude_members: bool,
        policy: Option<Value>,
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
    fn member_cases() {
        let f = fixtures();
        for case in &f.member_cases {
            let rules = Rules { exclude_members: case.exclude_members, ..f.rules.clone() };
            let got = check_claim(Some(&f.member_proposal), case.policy.as_ref(), &case.claimant, &rules).err();
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

    /// fixtures/random-claims.json: thousands of random and malformed inputs
    /// with the TypeScript verdicts (offchain/src/fuzz.ts). Any disagreement
    /// between the contracts and the offchain tools fails here.
    #[test]
    fn agrees_with_typescript_on_random_inputs() {
        #[derive(Deserialize)]
        struct Random {
            factory: String,
            claimant: String,
            rules: Rules,
            cases: Vec<RandomCase>,
            statics: Vec<RandomStatic>,
        }
        #[derive(Deserialize)]
        struct RandomCase {
            proposal: Option<Value>,
            policy: Option<Value>,
            exclude_members: bool,
            expect: Option<Reject>,
        }
        #[derive(Deserialize)]
        struct RandomStatic {
            claims: Vec<Claim>,
            expect: Vec<Option<Reject>>,
        }
        let f: Random = serde_json::from_str(include_str!("../../../fixtures/random-claims.json")).unwrap();
        let mut mismatches = vec![];
        for (i, c) in f.cases.iter().enumerate() {
            let rules = Rules { exclude_members: c.exclude_members, ..f.rules.clone() };
            let got = check_claim(c.proposal.as_ref(), c.policy.as_ref(), &f.claimant, &rules).err();
            if got != c.expect {
                mismatches.push(format!("case {i}: rust {got:?}, ts {:?}: {}", c.expect, c.proposal.as_ref().map(|p| p.to_string()).unwrap_or_default()));
            }
        }
        for (i, c) in f.statics.iter().enumerate() {
            let got = static_checks(&c.claims, &f.rules, &f.factory);
            if got != c.expect {
                mismatches.push(format!("static {i}: rust {got:?}, ts {:?}", c.expect));
            }
        }
        assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
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
