//! Track Record fast lane.
//!
//! A Sputnik role member that never holds funds. A contributor files an
//! ordinary Transfer proposal in the DAO, then registers it here with
//! claims about their past paid work. If the proposal is exactly what it
//! says, the claims qualify and the limits allow it, the request waits out
//! a veto window; after that anyone can trigger the lane's VoteApprove,
//! and Sputnik pays from the DAO treasury as usual. See RULES.md §3.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, Promise};
use track_record_rules::chain::{policy_daos, pre_checks, read_claims, read_policy, read_proposal, read_results, verdicts};
use track_record_rules::{parse_proposal, summarize, Claim, Reject, Rules, Transfer};

/// One read for the proposal itself, one per claim, and one per paying DAO
/// when members are excluded: at most 19 reads of 8 Tgas.
pub const MAX_CLAIMS: usize = 9;
const GAS_ON_REGISTERED: Gas = Gas::from_tgas(80);
const GAS_ACT: Gas = Gas::from_tgas(120);
const GAS_ON_EXECUTED: Gas = Gas::from_tgas(20);
const NS: u64 = 1_000_000_000;
/// After this long a request still in `Checking` can be released.
const STUCK_SECS: u64 = 3600;
/// What a registration must attach for the storage it causes: the request
/// record (kept as history, including a refusal reason or veto), its nonce
/// and its proposal index. 0.01 NEAR covers 1,000 bytes, well above the
/// worst case. Without it, anyone could drain the lane's balance by
/// registering junk (NEAR security checklist: storage cost attacks).
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct LaneConfig {
    /// What counts as a track record (RULES.md §1, §2).
    pub rules: Rules,
    /// Token the lane may approve payouts in; "" is native NEAR.
    pub pay_token: String,
    pub per_account_cap: U128,
    pub period_budget: U128,
    pub period_secs: u64,
    pub veto_secs: u64,
    pub max_proposal_age_secs: u64,
    pub guardians: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// Proposal and claims are being read.
    Checking,
    /// Passed every check; approvable once the veto window has passed.
    Waiting,
    Vetoed { by: AccountId },
    /// The lane's vote is in flight.
    Approving,
    Approved,
    /// Never approved; limits were credited back.
    Refused { reason: String },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: u64,
    pub account_id: AccountId,
    pub proposal_id: u64,
    pub amount: U128,
    pub nonce: u64,
    pub period: u64,
    pub registered_at_ns: u64,
    pub executable_at_ns: u64,
    pub distinct_daos: u32,
    pub payouts: u32,
    pub status: Status,
}

#[near(serializers = [json])]
pub struct Usage {
    pub period: u64,
    pub used_by_account: U128,
    pub used_by_period: U128,
    pub per_account_cap: U128,
    pub period_budget: U128,
}

#[near(contract_state)]
#[derive(near_sdk::PanicOnDefault)]
pub struct Lane {
    dao: AccountId,
    factory: AccountId,
    config: LaneConfig,
    requests: Vector<Request>,
    by_proposal: LookupMap<u64, u64>,
    used_by_account: LookupMap<(AccountId, u64), u128>,
    used_by_period: LookupMap<u64, u128>,
    nonces: LookupSet<(AccountId, u64)>,
}

#[near]
impl Lane {
    #[init]
    pub fn new(dao: AccountId, factory: AccountId, config: LaneConfig) -> Self {
        validate(&config);
        Self {
            dao,
            factory,
            config,
            requests: Vector::new(b"r"),
            by_proposal: LookupMap::new(b"p"),
            used_by_account: LookupMap::new(b"a"),
            used_by_period: LookupMap::new(b"b"),
            nonces: LookupSet::new(b"n"),
        }
    }

    /// Only the DAO itself (through a FunctionCall proposal) can change the config.
    pub fn configure(&mut self, config: LaneConfig) {
        require!(env::predecessor_account_id() == self.dao, "only the DAO can configure the lane");
        validate(&config);
        self.config = config;
        event("configured", json!({ "dao": self.dao }));
    }

    /// Registers the caller's own Transfer proposal for the fast lane.
    ///
    /// Limits are debited here, before any cross-contract call, and credited
    /// back if any check fails (RULES.md §3). The caller pays for the storage
    /// the request uses (`STORAGE_DEPOSIT`); anything attached above that is
    /// refunded.
    #[payable]
    pub fn register(&mut self, proposal_id: u64, amount: U128, claims: Vec<Claim>, nonce: u64) -> Promise {
        let account_id = env::predecessor_account_id();
        let attached = env::attached_deposit();
        require!(attached >= STORAGE_DEPOSIT, "attach 0.01 NEAR for the request's storage");
        require!(!claims.is_empty(), "no claims");
        require!(claims.len() <= MAX_CLAIMS, "too many claims");
        require!(amount.0 > 0, "amount must be positive");
        require!(!self.by_proposal.contains_key(&proposal_id), "proposal already registered");
        require!(self.nonces.insert((account_id.clone(), nonce)), "nonce already used");

        let period = self.current_period();
        let used_account = self.used_by_account.get(&(account_id.clone(), period)).copied().unwrap_or(0);
        let used_period = self.used_by_period.get(&period).copied().unwrap_or(0);
        require!(used_account + amount.0 <= self.config.per_account_cap.0, "over the per-account cap for this period");
        require!(used_period + amount.0 <= self.config.period_budget.0, "over the lane budget for this period");
        self.used_by_account.insert((account_id.clone(), period), used_account + amount.0);
        self.used_by_period.insert(period, used_period + amount.0);

        let id = self.requests.len() as u64;
        self.requests.push(Request {
            id,
            account_id: account_id.clone(),
            proposal_id,
            amount,
            nonce,
            period,
            registered_at_ns: env::block_timestamp(),
            executable_at_ns: 0,
            distinct_daos: 0,
            payouts: 0,
            status: Status::Checking,
        });
        self.by_proposal.insert(proposal_id, id);

        let refund = attached.saturating_sub(STORAGE_DEPOSIT);
        if !refund.is_zero() {
            Promise::new(account_id.clone()).transfer(refund).detach();
        }

        let statics = pre_checks(&claims, &self.config.rules, self.factory.as_str());
        let daos = policy_daos(&claims, &statics, &self.config.rules);
        read_claims(&claims, &statics)
            .into_iter()
            .chain(daos.iter().map(|d| read_policy(d)))
            .fold(read_proposal(self.dao.clone(), proposal_id), Promise::and)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REGISTERED)
                    .on_registered(id, claims, statics, daos),
            )
    }

    #[private]
    pub fn on_registered(&mut self, id: u64, claims: Vec<Claim>, statics: Vec<Option<Reject>>, policy_daos: Vec<String>) -> Status {
        let mut req = self.request_mut(id).clone();
        require!(req.status == Status::Checking, "request is not being checked");

        // Results: [own proposal, claims that passed pre_checks..., policies...]
        let n_reads = statics.iter().filter(|v| v.is_none()).count();
        let own = read_results(0, 1).pop().flatten();
        let raws = read_results(1, n_reads);
        let policies = read_results(1 + n_reads as u64, policy_daos.len());

        if let Err(reason) = self.check_own_proposal(own.as_ref(), &req) {
            return self.refuse(id, reason);
        }

        let verdicts = verdicts(req.account_id.as_str(), &claims, &statics, &raws, &policy_daos, &policies, &self.config.rules);
        let valid: Vec<&Claim> = claims.iter().zip(&verdicts).filter(|(_, v)| v.is_none()).map(|(c, _)| c).collect();
        let summary = summarize(&valid, &self.config.rules);
        if !summary.qualifies {
            return self.refuse(
                id,
                format!("track record too short: {} DAOs, {} payouts", summary.distinct_daos, summary.payouts),
            );
        }

        req.distinct_daos = summary.distinct_daos;
        req.payouts = summary.payouts;
        req.executable_at_ns = env::block_timestamp() + self.config.veto_secs * NS;
        req.status = Status::Waiting;
        *self.request_mut(id) = req.clone();
        event(
            "registered",
            json!({ "id": id, "account_id": req.account_id, "proposal_id": req.proposal_id,
                    "amount": req.amount, "executable_at_ns": req.executable_at_ns.to_string() }),
        );
        req.status
    }

    /// Any single guardian can stop a waiting request (RULES.md §3).
    pub fn veto(&mut self, id: u64) {
        let by = env::predecessor_account_id();
        require!(self.config.guardians.contains(&by), "only a guardian can veto");
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Waiting, "only a waiting request can be vetoed");
        self.credit_back(&req);
        self.request_mut(id).status = Status::Vetoed { by: by.clone() };
        event("vetoed", json!({ "id": id, "by": by }));
    }

    /// After the veto window, anyone can make the lane cast its vote.
    /// The outcome is read back from the DAO rather than assumed: a vote
    /// on an expired or rejected proposal succeeds without approving it.
    pub fn execute(&mut self, id: u64) -> Promise {
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Waiting, "request is not waiting");
        require!(env::block_timestamp() >= req.executable_at_ns, "veto window still open");
        self.request_mut(id).status = Status::Approving;

        let kind = json!({ "Transfer": {
            "token_id": self.config.pay_token,
            "receiver_id": req.account_id,
            "amount": req.amount,
            "msg": null,
        }});
        Promise::new(self.dao.clone())
            .function_call(
                "act_proposal".to_string(),
                json!({ "id": req.proposal_id, "action": "VoteApprove", "proposal": kind }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_ACT,
            )
            .then(read_proposal(self.dao.clone(), req.proposal_id))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_EXECUTED).on_executed(id))
    }

    #[private]
    pub fn on_executed(&mut self, id: u64) -> Status {
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Approving, "request is not being approved");
        let status = read_results(0, 1)
            .pop()
            .flatten()
            .and_then(|v| v.get("status").and_then(Value::as_str).map(str::to_string));
        match status.as_deref() {
            Some("Approved") => {
                self.request_mut(id).status = Status::Approved;
                event("approved", json!({ "id": id, "proposal_id": req.proposal_id }));
                Status::Approved
            }
            other => self.refuse(id, format!("DAO did not approve (status {})", other.unwrap_or("unknown"))),
        }
    }

    /// Recovery for a request whose check callback never landed (for
    /// example it ran out of gas). Without this a stuck request would hold
    /// budget forever. Anyone may call it once `STUCK_SECS` have passed.
    pub fn release_stuck(&mut self, id: u64) -> Status {
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Checking, "request is not stuck in checking");
        require!(env::block_timestamp() >= req.registered_at_ns + STUCK_SECS * NS, "too early to release");
        self.refuse(id, "check never completed".into())
    }

    /// Recovery for a request stuck in `Approving`: re-reads the proposal
    /// and settles the request from what the DAO actually recorded.
    pub fn recheck(&mut self, id: u64) -> Promise {
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Approving, "request is not being approved");
        read_proposal(self.dao.clone(), req.proposal_id)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_EXECUTED).on_executed(id))
    }

    // ---- views ----

    /// What `register` must attach, in yoctoNEAR.
    pub fn storage_deposit(&self) -> U128 {
        U128(STORAGE_DEPOSIT.as_yoctonear())
    }

    pub fn get_dao(&self) -> AccountId {
        self.dao.clone()
    }

    pub fn get_config(&self) -> LaneConfig {
        self.config.clone()
    }

    pub fn get_request(&self, id: u64) -> Option<Request> {
        self.requests.get(id as u32).cloned()
    }

    pub fn get_request_by_proposal(&self, proposal_id: u64) -> Option<Request> {
        self.by_proposal.get(&proposal_id).and_then(|id| self.get_request(*id))
    }

    pub fn get_requests(&self, from_index: u64, limit: u64) -> Vec<Request> {
        (from_index..from_index.saturating_add(limit).min(self.requests.len() as u64))
            .filter_map(|i| self.get_request(i))
            .collect()
    }

    pub fn get_usage(&self, account_id: AccountId) -> Usage {
        let period = self.current_period();
        Usage {
            period,
            used_by_account: U128(self.used_by_account.get(&(account_id, period)).copied().unwrap_or(0)),
            used_by_period: U128(self.used_by_period.get(&period).copied().unwrap_or(0)),
            per_account_cap: self.config.per_account_cap,
            period_budget: self.config.period_budget,
        }
    }
}

impl Lane {
    fn current_period(&self) -> u64 {
        env::block_timestamp() / NS / self.config.period_secs
    }

    fn request_mut(&mut self, id: u64) -> &mut Request {
        self.requests.get_mut(id as u32).unwrap_or_else(|| env::panic_str("no such request"))
    }

    /// The registered proposal must be exactly what the caller said:
    /// theirs, paying them, in the lane's token, for the registered amount,
    /// still open and recent (RULES.md §3 step 5).
    fn check_own_proposal(&self, raw: Option<&Value>, req: &Request) -> Result<(), String> {
        let p = raw.and_then(parse_proposal).ok_or("proposal not found in the DAO")?;
        if p.proposer != req.account_id.as_str() {
            return Err("proposal was filed by someone else".into());
        }
        if p.status != "InProgress" {
            return Err(format!("proposal is {}, not InProgress", p.status));
        }
        let t: Transfer = p.transfer.ok_or("proposal is not a Transfer")?;
        if t.receiver_id != req.account_id.as_str() {
            return Err("proposal pays someone else".into());
        }
        if t.token_id != self.config.pay_token {
            return Err("proposal pays in a token the lane doesn't approve".into());
        }
        if t.amount != req.amount.0.to_string() {
            return Err("proposal amount differs from the registered amount".into());
        }
        if t.msg.is_some() {
            return Err("transfers with a msg are not approved by the lane".into());
        }
        let age_ns = env::block_timestamp().saturating_sub(p.submission_time_ns);
        if age_ns > self.config.max_proposal_age_secs * NS {
            return Err("proposal is too old to register".into());
        }
        Ok(())
    }

    fn credit_back(&mut self, req: &Request) {
        let key = (req.account_id.clone(), req.period);
        let used_account = self.used_by_account.get(&key).copied().unwrap_or(0);
        self.used_by_account.insert(key, used_account.saturating_sub(req.amount.0));
        let used_period = self.used_by_period.get(&req.period).copied().unwrap_or(0);
        self.used_by_period.insert(req.period, used_period.saturating_sub(req.amount.0));
    }

    fn refuse(&mut self, id: u64, reason: String) -> Status {
        let req = self.request_mut(id).clone();
        self.credit_back(&req);
        let status = Status::Refused { reason: reason.clone() };
        self.request_mut(id).status = status.clone();
        event("refused", json!({ "id": id, "reason": reason }));
        status
    }
}

fn validate(c: &LaneConfig) {
    require!(c.period_secs > 0, "period_secs must be positive");
    require!(c.per_account_cap.0 <= c.period_budget.0, "per-account cap can't exceed the budget");
    require!(c.max_proposal_age_secs > 0, "max_proposal_age_secs must be positive");
    require!(!c.rules.trusted_daos.is_empty(), "trust at least one DAO");
    require!(!c.rules.tokens.is_empty(), "count at least one token");
}

fn event(name: &str, data: Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": "track_record_lane", "version": "1.0.0", "event": name, "data": [data] })
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn config() -> LaneConfig {
        LaneConfig {
            rules: Rules {
                trusted_daos: vec!["a.sputnikv2.testnet".into()],
                tokens: vec![track_record_rules::TokenFloor { token_id: "".into(), min_amount: "1".into() }],
                min_distinct_daos: 1,
                min_payouts: 1,
                exclude_members: false,
            },
            pay_token: "".into(),
            per_account_cap: U128(100),
            period_budget: U128(150),
            period_secs: 30 * 24 * 3600,
            veto_secs: 3600,
            max_proposal_age_secs: 3 * 24 * 3600,
            guardians: vec![accounts(3)],
        }
    }

    fn setup(caller: AccountId) -> Lane {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id("lane.testnet".parse().unwrap())
            .predecessor_account_id(caller)
            .attached_deposit(STORAGE_DEPOSIT)
            .block_timestamp(1_000_000 * NS);
        testing_env!(ctx.build());
        Lane::new("dao.sputnikv2.testnet".parse().unwrap(), "sputnikv2.testnet".parse().unwrap(), config())
    }

    fn claims() -> Vec<Claim> {
        vec![Claim { dao_id: "a.sputnikv2.testnet".into(), proposal_id: 1 }]
    }

    #[test]
    fn register_debits_both_limits_up_front() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(60), claims(), 1);
        let u = lane.get_usage(accounts(1));
        assert_eq!((u.used_by_account.0, u.used_by_period.0), (60, 60));
        assert_eq!(lane.get_request(0).unwrap().status, Status::Checking);
    }

    #[test]
    #[should_panic(expected = "over the per-account cap")]
    fn per_account_cap_holds() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(60), claims(), 1);
        let _ = lane.register(8, U128(60), claims(), 2);
    }

    #[test]
    #[should_panic(expected = "over the lane budget")]
    fn period_budget_holds_across_accounts() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(100), claims(), 1);
        testing_env!(VMContextBuilder::new()
            .current_account_id("lane.testnet".parse().unwrap())
            .predecessor_account_id(accounts(2))
            .attached_deposit(STORAGE_DEPOSIT)
            .block_timestamp(1_000_000 * NS)
            .build());
        let _ = lane.register(8, U128(60), claims(), 1);
    }

    #[test]
    #[should_panic(expected = "nonce already used")]
    fn nonce_is_single_use() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(10), claims(), 1);
        let _ = lane.register(8, U128(10), claims(), 1);
    }

    #[test]
    #[should_panic(expected = "proposal already registered")]
    fn a_proposal_registers_once() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(10), claims(), 1);
        let _ = lane.register(7, U128(10), claims(), 2);
    }

    #[test]
    #[should_panic(expected = "only the DAO can configure")]
    fn only_the_dao_configures() {
        let mut lane = setup(accounts(1));
        lane.configure(config());
    }

    #[test]
    #[should_panic(expected = "only a guardian can veto")]
    fn strangers_cannot_veto() {
        let mut lane = setup(accounts(1));
        lane.veto(0);
    }

    #[test]
    #[should_panic(expected = "attach 0.01 NEAR")]
    fn registering_without_a_storage_deposit_fails() {
        let mut lane = setup(accounts(1));
        testing_env!(VMContextBuilder::new()
            .current_account_id("lane.testnet".parse().unwrap())
            .predecessor_account_id(accounts(1))
            .block_timestamp(1_000_000 * NS)
            .build());
        let _ = lane.register(7, U128(10), claims(), 1);
    }

    #[test]
    fn refusing_credits_the_limits_back() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(60), claims(), 1);
        lane.refuse(0, "test".into());
        let u = lane.get_usage(accounts(1));
        assert_eq!((u.used_by_account.0, u.used_by_period.0), (0, 0));
    }

    #[test]
    fn a_stuck_check_can_be_released_after_an_hour() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(60), claims(), 1);
        testing_env!(VMContextBuilder::new()
            .current_account_id("lane.testnet".parse().unwrap())
            .predecessor_account_id(accounts(2))
            .block_timestamp((1_000_000 + STUCK_SECS) * NS)
            .build());
        assert!(matches!(lane.release_stuck(0), Status::Refused { .. }));
        assert_eq!(lane.get_usage(accounts(1)).used_by_account.0, 0);
    }

    #[test]
    #[should_panic(expected = "too early to release")]
    fn a_fresh_check_cannot_be_released() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(60), claims(), 1);
        lane.release_stuck(0);
    }

    #[test]
    fn own_proposal_must_match_exactly() {
        let lane = setup(accounts(1));
        let req = Request {
            id: 0,
            account_id: accounts(1),
            proposal_id: 7,
            amount: U128(60),
            nonce: 1,
            period: 0,
            registered_at_ns: 0,
            executable_at_ns: 0,
            distinct_daos: 0,
            payouts: 0,
            status: Status::Checking,
        };
        let p = |proposer: &str, receiver: &str, token: &str, amount: &str, status: &str, t: u64| {
            json!({ "id": 7, "proposer": proposer, "description": "",
                    "kind": { "Transfer": { "token_id": token, "receiver_id": receiver, "amount": amount, "msg": null } },
                    "status": status, "vote_counts": {}, "votes": {}, "submission_time": t.to_string() })
        };
        let me = accounts(1).to_string();
        let now = 1_000_000 * NS;
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "", "60", "InProgress", now)), &req).is_ok());
        assert!(lane.check_own_proposal(Some(&p("eve.near", &me, "", "60", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, "eve.near", "", "60", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "usdc.near", "60", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "", "61", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "", "60", "Approved", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "", "60", "InProgress", 0)), &req).is_err());
        assert!(lane.check_own_proposal(None, &req).is_err());
    }
}
