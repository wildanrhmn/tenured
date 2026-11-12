//! End-to-end tests on a local sandbox node, against the exact sputnikdao2
//! code the testnet factory deploys (contracts/res/sputnikdao2.wasm, whose
//! sha256 equals `sputnikv2.testnet.get_default_code_hash()`).
//!
//! Build the contracts first: ./scripts/build-contracts.sh

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const NEAR: u128 = 10u128.pow(24);

fn wasm(path: &str) -> Vec<u8> {
    let full = format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), path);
    std::fs::read(&full).unwrap_or_else(|_| panic!("missing {full}; run ./scripts/build-contracts.sh"))
}

struct World {
    worker: Worker<Sandbox>,
    factory: Account,
    council: Account,
    guardian: Account,
    dev: Account,
    eve: Account,
    alpha: Contract,
    beta: Contract,
    fund: Contract,
    lane: Contract,
    verifier: Contract,
}

async fn user(root: &Account, name: &str) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?)
}

/// A Sputnik DAO created as `<name>.<factory>` with one council member,
/// mirroring what the real factory does.
async fn dao(factory: &Account, name: &str, council: &Account) -> anyhow::Result<Contract> {
    let acc = factory
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(60))
        .transact()
        .await?
        .into_result()?;
    let dao = acc.deploy(&wasm("res/sputnikdao2.wasm")).await?.into_result()?;
    dao.call("new")
        .args_json(json!({
            "config": { "name": name, "purpose": "test", "metadata": "" },
            "policy": [council.id()],
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(dao)
}

async fn propose(dao: &Contract, who: &Account, kind: Value) -> anyhow::Result<u64> {
    let id: u64 = who
        .call(dao.id(), "add_proposal")
        .args_json(json!({ "proposal": { "description": "test", "kind": kind } }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    Ok(id)
}

async fn act(dao: &Contract, who: &Account, id: u64, action: &str, kind: Value) -> ExecutionFinalResult {
    who.call(dao.id(), "act_proposal")
        .args_json(json!({ "id": id, "action": action, "proposal": kind }))
        .max_gas()
        .transact()
        .await
        .unwrap()
}

fn transfer(to: &AccountId, near: u128) -> Value {
    json!({ "Transfer": { "token_id": "", "receiver_id": to, "amount": (near * NEAR).to_string(), "msg": null } })
}

/// A payout the council approved: real history for the track record.
async fn paid(dao: &Contract, council: &Account, to: &Account, near: u128) -> anyhow::Result<u64> {
    let kind = transfer(to.id(), near);
    let id = propose(dao, to, kind.clone()).await?;
    act(dao, council, id, "VoteApprove", kind).await.into_result()?;
    Ok(id)
}

async fn status(dao: &Contract, id: u64) -> anyhow::Result<String> {
    let p: Value = dao.view("get_proposal").args_json(json!({ "id": id })).await?.json()?;
    Ok(p["status"].as_str().unwrap().to_string())
}

async fn setup(veto_secs: u64) -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let factory = root
        .create_subaccount("factory")
        .initial_balance(NearToken::from_near(500))
        .transact()
        .await?
        .into_result()?;
    let council = user(&root, "council").await?;
    let guardian = user(&root, "guardian").await?;
    let dev = user(&root, "dev").await?;
    let eve = user(&root, "eve").await?;

    let alpha = dao(&factory, "alpha", &council).await?;
    let beta = dao(&factory, "beta", &council).await?;
    let fund = dao(&factory, "fund", &council).await?;

    let lane_acc = root
        .create_subaccount("lane")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let lane = lane_acc.deploy(&wasm("target/near/track_record_lane/track_record_lane.wasm")).await?.into_result()?;
    lane.call("new")
        .args_json(json!({
            "dao": fund.id(),
            "factory": factory.id(),
            "config": {
                "rules": {
                    "trusted_daos": [alpha.id(), beta.id()],
                    "tokens": [{ "token_id": "", "min_amount": (NEAR).to_string() }],
                    "min_distinct_daos": 2,
                    "min_payouts": 3,
                },
                "pay_token": "",
                "per_account_cap": (5 * NEAR).to_string(),
                "period_budget": (8 * NEAR).to_string(),
                "period_secs": 30 * 24 * 3600,
                "veto_secs": veto_secs,
                "max_proposal_age_secs": 3 * 24 * 3600,
                "guardians": [guardian.id()],
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let verifier_acc = root
        .create_subaccount("verifier")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let verifier = verifier_acc
        .deploy(&wasm("target/near/track_record_verifier/track_record_verifier.wasm"))
        .await?
        .into_result()?;
    verifier.call("new").args_json(json!({ "factory": factory.id() })).transact().await?.into_result()?;

    // Install the lane in the funding DAO: one role, one permission.
    let role = json!({ "ChangePolicyAddOrUpdateRole": { "role": {
        "name": "fastlane",
        "kind": { "Group": [lane.id()] },
        "permissions": ["transfer:VoteApprove"],
        "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1] } },
    }}});
    let id = propose(&fund, &council, role.clone()).await?;
    act(&fund, &council, id, "VoteApprove", role).await.into_result()?;

    Ok(World { worker, factory, council, guardian, dev, eve, alpha, beta, fund, lane, verifier })
}

impl World {
    /// dev's history: two payouts from alpha, one from beta.
    async fn history(&self) -> anyhow::Result<Value> {
        let a0 = paid(&self.alpha, &self.council, &self.dev, 2).await?;
        let a1 = paid(&self.alpha, &self.council, &self.dev, 3).await?;
        let b0 = paid(&self.beta, &self.council, &self.dev, 2).await?;
        Ok(json!([
            { "dao_id": self.alpha.id(), "proposal_id": a0 },
            { "dao_id": self.alpha.id(), "proposal_id": a1 },
            { "dao_id": self.beta.id(), "proposal_id": b0 },
        ]))
    }

    async fn register(&self, who: &Account, proposal_id: u64, near: u128, claims: &Value, nonce: u64) -> ExecutionFinalResult {
        who.call(self.lane.id(), "register")
            .args_json(json!({ "proposal_id": proposal_id, "amount": (near * NEAR).to_string(), "claims": claims, "nonce": nonce }))
            .max_gas()
            .transact()
            .await
            .unwrap()
    }

    async fn request(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self.lane.view("get_request").args_json(json!({ "id": id })).await?.json()?)
    }

    async fn execute(&self, who: &Account, id: u64) -> ExecutionFinalResult {
        who.call(self.lane.id(), "execute").args_json(json!({ "id": id })).max_gas().transact().await.unwrap()
    }

    /// Advances the sandbox clock past `secs`.
    async fn wait(&self, secs: u64) -> anyhow::Result<()> {
        let start = self.worker.view_block().await?.timestamp();
        while self.worker.view_block().await?.timestamp() < start + secs * 1_000_000_000 {
            self.worker.fast_forward(50).await?;
        }
        Ok(())
    }
}

fn status_of(req: &Value) -> String {
    match &req["status"] {
        Value::String(s) => s.clone(),
        Value::Object(o) => o.keys().next().unwrap().clone(),
        other => other.to_string(),
    }
}

fn failure_text(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

#[tokio::test]
async fn proven_contributor_is_paid_after_the_veto_window() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;

    let pid = propose(&w.fund, &w.dev, transfer(w.dev.id(), 4)).await?;
    let r = w.register(&w.dev, pid, 4, &claims, 1).await;
    assert!(r.is_success(), "{}", failure_text(&r));
    println!("register with 3 claims burnt {} Tgas", r.total_gas_burnt.as_tgas());
    let req = w.request(0).await?;
    assert_eq!(status_of(&req), "Waiting", "{req}");
    assert_eq!(req["distinct_daos"], 2);
    assert_eq!(req["payouts"], 3);

    // Too early: the veto window is still open.
    let early = w.execute(&w.eve, 0).await;
    assert!(early.is_failure());
    assert!(failure_text(&early).contains("veto window still open"));

    w.wait(31).await?;
    let before = w.dev.view_account().await?.balance;
    let r = w.execute(&w.eve, 0).await; // anyone may trigger it
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(status_of(&w.request(0).await?), "Approved");
    assert_eq!(status(&w.fund, pid).await?, "Approved");
    let after = w.dev.view_account().await?.balance;
    // 4 NEAR payout plus the 1 NEAR bond returned by Sputnik.
    assert!(after.as_yoctonear() - before.as_yoctonear() >= 5 * NEAR - NEAR / 100);
    Ok(())
}

#[tokio::test]
async fn a_single_guardian_can_veto() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    let pid = propose(&w.fund, &w.dev, transfer(w.dev.id(), 4)).await?;
    assert!(w.register(&w.dev, pid, 4, &claims, 1).await.is_success());

    let not_guardian = w.eve.call(w.lane.id(), "veto").args_json(json!({ "id": 0 })).transact().await?;
    assert!(not_guardian.is_failure());
    let r = w.guardian.call(w.lane.id(), "veto").args_json(json!({ "id": 0 })).transact().await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(status_of(&w.request(0).await?), "Vetoed");

    w.wait(31).await?;
    assert!(w.execute(&w.eve, 0).await.is_failure());
    assert_eq!(status(&w.fund, pid).await?, "InProgress");
    let usage: Value = w.lane.view("get_usage").args_json(json!({ "account_id": w.dev.id() })).await?.json()?;
    assert_eq!(usage["used_by_account"], "0");
    Ok(())
}

#[tokio::test]
async fn council_rejection_during_the_window_wins() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    let kind = transfer(w.dev.id(), 4);
    let pid = propose(&w.fund, &w.dev, kind.clone()).await?;
    assert!(w.register(&w.dev, pid, 4, &claims, 1).await.is_success());
    act(&w.fund, &w.council, pid, "VoteReject", kind).await.into_result()?;

    w.wait(31).await?;
    let r = w.execute(&w.eve, 0).await;
    assert!(r.is_success(), "{}", failure_text(&r));
    let req = w.request(0).await?;
    assert_eq!(status_of(&req), "Refused", "{req}");
    assert_eq!(status(&w.fund, pid).await?, "Rejected");
    Ok(())
}

#[tokio::test]
async fn the_lane_refuses_proposals_that_are_not_exactly_yours() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;

    // eve's proposal paying eve, registered by dev.
    let eves = propose(&w.fund, &w.eve, transfer(w.eve.id(), 4)).await?;
    assert!(w.register(&w.dev, eves, 4, &claims, 1).await.is_success());
    assert_eq!(status_of(&w.request(0).await?), "Refused");

    // dev's proposal for 4 NEAR registered as 3 NEAR.
    let pid = propose(&w.fund, &w.dev, transfer(w.dev.id(), 4)).await?;
    assert!(w.register(&w.dev, pid, 3, &claims, 2).await.is_success());
    assert_eq!(status_of(&w.request(1).await?), "Refused");

    // dev presenting someone else's claims: eve has no history of her own.
    let pid2 = propose(&w.fund, &w.eve, transfer(w.eve.id(), 2)).await?;
    assert!(w.register(&w.eve, pid2, 2, &claims, 1).await.is_success());
    let req = w.request(2).await?;
    assert_eq!(status_of(&req), "Refused", "{req}");

    // None of them can be executed, and none of them hold budget.
    w.wait(31).await?;
    for id in 0..3 {
        assert!(w.execute(&w.eve, id).await.is_failure());
    }
    let usage: Value = w.lane.view("get_usage").args_json(json!({ "account_id": w.dev.id() })).await?.json()?;
    assert_eq!(usage["used_by_period"], "0");
    for id in [eves, pid, pid2] {
        assert_eq!(status(&w.fund, id).await?, "InProgress");
    }
    Ok(())
}

#[tokio::test]
async fn limits_hold_and_refused_requests_free_them() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;

    // Cap is 5 NEAR per account: 4 + 2 would exceed it.
    let p1 = propose(&w.fund, &w.dev, transfer(w.dev.id(), 4)).await?;
    assert!(w.register(&w.dev, p1, 4, &claims, 1).await.is_success());
    let p2 = propose(&w.fund, &w.dev, transfer(w.dev.id(), 2)).await?;
    let over = w.register(&w.dev, p2, 2, &claims, 2).await;
    assert!(failure_text(&over).contains("per-account cap"));

    // Same nonce or same proposal twice is refused outright.
    assert!(failure_text(&w.register(&w.dev, p2, 1, &claims, 1).await).contains("nonce already used"));
    assert!(failure_text(&w.register(&w.dev, p1, 1, &claims, 9).await).contains("already registered"));
    Ok(())
}

#[tokio::test]
async fn verifier_attests_from_the_daos_own_records() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    let rules = json!({
        "trusted_daos": [w.alpha.id(), w.beta.id()],
        "tokens": [{ "token_id": "", "min_amount": NEAR.to_string() }],
        "min_distinct_daos": 2,
        "min_payouts": 3,
    });

    let r = w.eve
        .call(w.verifier.id(), "verify")
        .args_json(json!({ "account_id": w.dev.id(), "claims": claims, "rules": rules }))
        .max_gas()
        .transact()
        .await?;
    let a: Value = r.clone().into_result()?.json()?;
    assert_eq!(a["summary"]["qualifies"], true, "{a}");
    println!("verify with 3 claims burnt {} Tgas", r.total_gas_burnt.as_tgas());

    // The same claims presented by eve are someone else's payouts.
    let a: Value = w.eve
        .call(w.verifier.id(), "verify")
        .args_json(json!({ "account_id": w.eve.id(), "claims": claims, "rules": rules }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(a["summary"]["qualifies"], false);
    assert!(a["results"].as_array().unwrap().iter().all(|r| r["reason"] == "WrongReceiver"));

    // A DAO outside the factory namespace never counts, even if listed.
    let fake = json!([{ "dao_id": w.dev.id(), "proposal_id": 0 }]);
    let mut rules2 = rules.clone();
    rules2["trusted_daos"] = json!([w.dev.id()]);
    let a: Value = w.eve
        .call(w.verifier.id(), "verify")
        .args_json(json!({ "account_id": w.dev.id(), "claims": fake, "rules": rules2 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(a["results"][0]["reason"], "NotFactoryDao");
    let _ = &w.factory;
    Ok(())
}
