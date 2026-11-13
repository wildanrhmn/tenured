//! Tenured fast lane.
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
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use tenured_rules::chain::{
    policy_daos, pre_checks, read_claims, read_policy, read_proposal, read_results, verdicts, MAX_POLICY_BYTES,
    MAX_PROPOSAL_BYTES,
};
use tenured_rules::{parse_proposal, summarize, Claim, Reject, Rules, Transfer};

/// Reads per registration: the proposal, the DAO's policy, one per claim
/// and, when members are excluded, one policy per paying DAO. At most 20.
pub const MAX_CLAIMS: usize = 9;
const GAS_ON_REGISTERED: Gas = Gas::from_tgas(70);
const GAS_ACT: Gas = Gas::from_tgas(120);
const GAS_ON_EXECUTED: Gas = Gas::from_tgas(20);
const NS: u64 = 1_000_000_000;
/// After this long a request still in `Checking` can be released. A check
/// normally settles within a few blocks.
const STUCK_SECS: u64 = 600;
/// `recheck` only after this long in `Approving`, so it can't race the
/// vote's own callback.
const RECHECK_SECS: u64 = 600;
/// The lane never votes this close to a proposal's expiry. A vote that
/// lands after expiry marks the proposal Expired in a way Sputnik can no
/// longer finalize, which would lock the contributor's bond.
const EXPIRY_MARGIN_SECS: u64 = 300;
/// Upper bounds on config durations, so `secs * NS` can't overflow.
const MAX_WINDOW_SECS: u64 = 30 * 24 * 3600;
const MAX_AGE_SECS: u64 = 365 * 24 * 3600;
/// What a registration must attach for the storage it causes: the request
/// record (kept as history, including a refusal reason or veto), its nonce
/// and its index entries. 0.01 NEAR covers 1,000 bytes; a request uses
/// about 320. Without it, anyone could drain the lane's balance by
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
    /// The lane voted but the DAO didn't approve (for example its policy
    /// changed). The vote stands, so the amount stays counted against the
    /// limits; `recheck` settles it later.
    Voted,
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
    /// When the DAO's proposal expires (submission time + proposal period).
    pub expires_at_ns: u64,
    pub approving_at_ns: u64,
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
    /// (account, proposal) → request. Keyed by account so that someone
    /// registering *your* proposal can never block you; only the proposer
    /// can pass the checks anyway.
    registered: LookupMap<(AccountId, u64), u64>,
    /// proposal → the request that passed its checks.
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
            registered: LookupMap::new(b"g"),
            by_proposal: LookupMap::new(b"p"),
            used_by_account: LookupMap::new(b"a"),
            used_by_period: LookupMap::new(b"b"),
            nonces: LookupSet::new(b"n"),
        }
    }

    /// Only the DAO itself (through a FunctionCall proposal) can change the
    /// config. The pay token and the period length are fixed for the life of
    /// the lane, because the limits already spent are counted in them.
    pub fn configure(&mut self, config: LaneConfig) {
        require!(env::predecessor_account_id() == self.dao, "only the DAO can configure the lane");
        validate(&config);
        require!(config.pay_token == self.config.pay_token, "pay_token is fixed; deploy a new lane to change it");
        require!(config.period_secs == self.config.period_secs, "period_secs is fixed; deploy a new lane to change it");
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
        require!(
            !self.registered.contains_key(&(account_id.clone(), proposal_id)),
            "you already registered this proposal"
        );
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
            expires_at_ns: 0,
            approving_at_ns: 0,
            distinct_daos: 0,
            payouts: 0,
            status: Status::Checking,
        });
        self.registered.insert((account_id.clone(), proposal_id), id);

        let refund = attached.saturating_sub(STORAGE_DEPOSIT);
        if !refund.is_zero() {
            Promise::new(account_id.clone()).transfer(refund).detach();
        }

        // Results, in order: [own proposal, the DAO's policy, claims that
        // passed pre_checks..., paying DAOs' policies...]
        let statics = pre_checks(&claims, &self.config.rules, self.factory.as_str());
        let daos = policy_daos(&claims, &statics, &self.config.rules);
        read_claims(&claims, &statics)
            .into_iter()
            .chain(daos.iter().map(|d| read_policy(d)))
            .fold(read_proposal(self.dao.clone(), proposal_id).and(read_policy(self.dao.as_str())), Promise::and)
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

        let n_reads = statics.iter().filter(|v| v.is_none()).count();
        let own = read_results(0, 1, MAX_PROPOSAL_BYTES).pop().flatten();
        let dao_policy = read_results(1, 1, MAX_POLICY_BYTES).pop().flatten();
        let raws = read_results(2, n_reads, MAX_PROPOSAL_BYTES);
        let policies = read_results(2 + n_reads as u64, policy_daos.len(), MAX_POLICY_BYTES);

        let submitted = match self.check_own_proposal(own.as_ref(), &req) {
            Ok(t) => t,
            Err(reason) => return self.refuse(id, reason),
        };
        let Some(period_ns) = dao_policy.as_ref().and_then(proposal_period_ns) else {
            return self.refuse(id, "can't read the DAO's proposal period".into());
        };
        req.executable_at_ns = env::block_timestamp() + self.config.veto_secs * NS;
        req.expires_at_ns = submitted.saturating_add(period_ns);
        if req.executable_at_ns + EXPIRY_MARGIN_SECS * NS > req.expires_at_ns {
            return self.refuse(id, "the veto window ends after the proposal expires".into());
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
        req.status = Status::Waiting;
        *self.request_mut(id) = req.clone();
        self.by_proposal.insert(req.proposal_id, id);
        event(
            "registered",
            json!({ "id": id, "account_id": req.account_id, "proposal_id": req.proposal_id,
                    "amount": req.amount, "executable_at_ns": req.executable_at_ns.to_string(),
                    "expires_at_ns": req.expires_at_ns.to_string() }),
        );
        req.status
    }

    /// Any single guardian can stop a request until it is executed
    /// (RULES.md §3). A vetoed proposal can't be registered again.
    pub fn veto(&mut self, id: u64) {
        let by = env::predecessor_account_id();
        require!(self.config.guardians.contains(&by), "only a guardian can veto");
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Waiting, "only a waiting request can be vetoed");
        self.credit_back(&req);
        self.request_mut(id).status = Status::Vetoed { by: by.clone() };
        event("vetoed", json!({ "id": id, "by": by }));
    }

    /// After the veto window, anyone can make the lane cast its vote. The
    /// outcome is read back from the DAO rather than assumed: a vote that
    /// doesn't approve still succeeds as a call.
    pub fn execute(&mut self, id: u64) -> PromiseOrValue<Status> {
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Waiting, "request is not waiting");
        let now = env::block_timestamp();
        require!(now >= req.executable_at_ns, "veto window still open");
        if now + EXPIRY_MARGIN_SECS * NS > req.expires_at_ns {
            // Don't vote: the contributor can still finalize the expired
            // proposal and get their bond back.
            return PromiseOrValue::Value(self.refuse(id, "proposal expires before a vote could land".into()));
        }
        let r = self.request_mut(id);
        r.status = Status::Approving;
        r.approving_at_ns = now;

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
            .into()
    }

    /// Settles a request from what the DAO recorded after the lane's vote.
    #[private]
    pub fn on_executed(&mut self, id: u64) -> Status {
        let req = self.request_mut(id).clone();
        require!(matches!(req.status, Status::Approving | Status::Voted), "request has no vote to settle");
        let proposal = read_results(0, 1, MAX_PROPOSAL_BYTES).pop().flatten();
        let status = proposal.as_ref().and_then(|v| v.get("status")).and_then(Value::as_str).map(str::to_string);
        // Whether the lane's own vote is on record: if the call failed (for
        // example the DAO removed the role) there is nothing standing.
        let lane_voted = proposal
            .as_ref()
            .and_then(|v| v.get("votes"))
            .and_then(|m| m.get(env::current_account_id().as_str()))
            .and_then(Value::as_str)
            == Some("Approve");
        match status.as_deref() {
            Some("Approved") => {
                self.request_mut(id).status = Status::Approved;
                event("approved", json!({ "id": id, "proposal_id": req.proposal_id }));
                Status::Approved
            }
            // Dead for good: nothing can pay it out any more.
            Some("Rejected") | Some("Removed") | Some("Expired") | None => {
                self.refuse(id, format!("DAO did not approve (status {})", status.as_deref().unwrap_or("gone")))
            }
            // InProgress or Failed with the lane's vote on record: it could
            // still pay out, so the amount stays counted.
            Some(other) if lane_voted => {
                self.request_mut(id).status = Status::Voted;
                event("voted", json!({ "id": id, "proposal_id": req.proposal_id, "dao_status": other }));
                Status::Voted
            }
            Some(other) => self.refuse(id, format!("the lane's vote did not land (status {other})")),
        }
    }

    /// Recovery for a request whose check callback never landed (for
    /// example it ran out of gas). Without this a stuck request would hold
    /// budget. Anyone may call it once `STUCK_SECS` have passed.
    pub fn release_stuck(&mut self, id: u64) -> Status {
        let req = self.request_mut(id).clone();
        require!(req.status == Status::Checking, "request is not stuck in checking");
        require!(env::block_timestamp() >= req.registered_at_ns + STUCK_SECS * NS, "too early to release");
        self.refuse(id, "check never completed".into())
    }

    /// Re-reads the proposal and settles a request stuck in `Approving`
    /// (after `RECHECK_SECS`) or one the lane voted on that the DAO hadn't
    /// approved yet (`Voted`).
    pub fn recheck(&mut self, id: u64) -> Promise {
        let req = self.request_mut(id).clone();
        match req.status {
            Status::Approving => require!(
                env::block_timestamp() >= req.approving_at_ns + RECHECK_SECS * NS,
                "the vote may still be in flight"
            ),
            Status::Voted => {}
            _ => env::panic_str("request has no vote to settle"),
        }
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
        u32::try_from(id).ok().and_then(|i| self.requests.get(i)).cloned()
    }

    /// The request for `proposal_id` that passed its checks, if any.
    pub fn get_request_by_proposal(&self, proposal_id: u64) -> Option<Request> {
        self.by_proposal.get(&proposal_id).and_then(|id| self.get_request(*id))
    }

    pub fn get_requests(&self, from_index: u64, limit: u64) -> Vec<Request> {
        (from_index..from_index.saturating_add(limit.min(100)).min(self.requests.len() as u64))
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
        u32::try_from(id)
            .ok()
            .and_then(|i| self.requests.get_mut(i))
            .unwrap_or_else(|| env::panic_str("no such request"))
    }

    /// The registered proposal must be exactly what the caller said:
    /// theirs, paying them, in the lane's token, for the registered amount,
    /// still open and recent (RULES.md §3). Returns its submission time.
    fn check_own_proposal(&self, raw: Option<&Value>, req: &Request) -> Result<u64, String> {
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
        Ok(p.submission_time_ns)
    }

    fn credit_back(&mut self, req: &Request) {
        let key = (req.account_id.clone(), req.period);
        let used_account = self.used_by_account.get(&key).copied().unwrap_or(0);
        self.used_by_account.insert(key, used_account.saturating_sub(req.amount.0));
        let used_period = self.used_by_period.get(&req.period).copied().unwrap_or(0);
        self.used_by_period.insert(req.period, used_period.saturating_sub(req.amount.0));
    }

    /// Ends a request without a payout: credits the limits back and lets the
    /// account register the same proposal again later.
    fn refuse(&mut self, id: u64, reason: String) -> Status {
        let req = self.request_mut(id).clone();
        self.credit_back(&req);
        self.registered.remove(&(req.account_id.clone(), req.proposal_id));
        let status = Status::Refused { reason: reason.clone() };
        self.request_mut(id).status = status.clone();
        event("refused", json!({ "id": id, "reason": reason }));
        status
    }
}

/// `proposal_period` from a Sputnik `get_policy` response, in nanoseconds.
fn proposal_period_ns(policy: &Value) -> Option<u64> {
    let s = policy.get("proposal_period")?.as_str()?;
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

fn validate(c: &LaneConfig) {
    require!(c.period_secs > 0 && c.period_secs <= 10 * MAX_AGE_SECS, "period_secs must be between 1 s and 10 years");
    require!(c.veto_secs <= MAX_WINDOW_SECS, "veto_secs can be at most 30 days");
    require!(
        c.max_proposal_age_secs > 0 && c.max_proposal_age_secs <= MAX_AGE_SECS,
        "max_proposal_age_secs must be between 1 s and a year"
    );
    require!(c.per_account_cap.0 <= c.period_budget.0, "per-account cap can't exceed the budget");
    require!(!c.rules.trusted_daos.is_empty(), "trust at least one DAO");
    require!(!c.rules.tokens.is_empty(), "count at least one token");
    require!(c.rules.min_distinct_daos >= 1 && c.rules.min_payouts >= 1, "the bar must be at least one DAO and one payout");
}

fn event(name: &str, data: Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": "tenured_lane", "version": "1.0.0", "event": name, "data": [data] })
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
                tokens: vec![tenured_rules::TokenFloor { token_id: "".into(), min_amount: "1".into() }],
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

    fn context(caller: AccountId, secs: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("lane.testnet".parse().unwrap())
            .predecessor_account_id(caller)
            .attached_deposit(STORAGE_DEPOSIT)
            .block_timestamp(secs * NS)
            .build());
    }

    fn setup(caller: AccountId) -> Lane {
        context(caller, 1_000_000);
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
        context(accounts(2), 1_000_000);
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
    #[should_panic(expected = "you already registered this proposal")]
    fn an_account_registers_a_proposal_once() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(10), claims(), 1);
        let _ = lane.register(7, U128(10), claims(), 2);
    }

    #[test]
    fn someone_else_registering_your_proposal_does_not_block_you() {
        let mut lane = setup(accounts(2));
        let _ = lane.register(7, U128(10), claims(), 1); // the squatter
        context(accounts(1), 1_000_000);
        let _ = lane.register(7, U128(10), claims(), 1); // the proposer, unaffected
        assert_eq!(lane.get_request(1).unwrap().account_id, accounts(1));
    }

    #[test]
    fn a_refused_proposal_can_be_registered_again() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(10), claims(), 1);
        lane.refuse(0, "test".into());
        let _ = lane.register(7, U128(10), claims(), 2);
        assert_eq!(lane.get_request(1).unwrap().status, Status::Checking);
    }

    #[test]
    #[should_panic(expected = "only the DAO can configure")]
    fn only_the_dao_configures() {
        let mut lane = setup(accounts(1));
        lane.configure(config());
    }

    #[test]
    #[should_panic(expected = "pay_token is fixed")]
    fn the_pay_token_cannot_change() {
        let mut lane = setup(accounts(1));
        context("dao.sputnikv2.testnet".parse().unwrap(), 1_000_000);
        lane.configure(LaneConfig { pay_token: "usdc.testnet".into(), ..config() });
    }

    #[test]
    #[should_panic(expected = "at least one DAO and one payout")]
    fn a_zero_bar_is_rejected() {
        context(accounts(1), 1_000_000);
        let mut c = config();
        c.rules.min_payouts = 0;
        Lane::new("dao.sputnikv2.testnet".parse().unwrap(), "sputnikv2.testnet".parse().unwrap(), c);
    }

    #[test]
    #[should_panic(expected = "veto_secs can be at most 30 days")]
    fn absurd_durations_are_rejected() {
        context(accounts(1), 1_000_000);
        Lane::new(
            "dao.sputnikv2.testnet".parse().unwrap(),
            "sputnikv2.testnet".parse().unwrap(),
            LaneConfig { veto_secs: u64::MAX, ..config() },
        );
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
    fn a_stuck_check_can_be_released_after_ten_minutes() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(60), claims(), 1);
        context(accounts(2), 1_000_000 + STUCK_SECS);
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
    fn huge_request_ids_do_not_alias_small_ones() {
        let mut lane = setup(accounts(1));
        let _ = lane.register(7, U128(10), claims(), 1);
        assert!(lane.get_request(0).is_some());
        assert!(lane.get_request(1u64 << 32).is_none());
    }

    #[test]
    fn proposal_period_is_read_from_the_policy() {
        assert_eq!(proposal_period_ns(&json!({ "proposal_period": "604800000000000" })), Some(604_800_000_000_000));
        assert_eq!(proposal_period_ns(&json!({ "proposal_period": "+5" })), None);
        assert_eq!(proposal_period_ns(&json!({})), None);
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
            expires_at_ns: 0,
            approving_at_ns: 0,
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
        assert_eq!(lane.check_own_proposal(Some(&p(&me, &me, "", "60", "InProgress", now)), &req), Ok(now));
        assert!(lane.check_own_proposal(Some(&p("eve.near", &me, "", "60", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, "eve.near", "", "60", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "usdc.near", "60", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "", "61", "InProgress", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "", "60", "Approved", now)), &req).is_err());
        assert!(lane.check_own_proposal(Some(&p(&me, &me, "", "60", "InProgress", 0)), &req).is_err());
        assert!(lane.check_own_proposal(None, &req).is_err());
    }
}
