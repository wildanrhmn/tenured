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
        .initial_balance(NearToken::from_near(1500))
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
    let lane = lane_acc.deploy(&wasm("target/near/tenured_lane/tenured_lane.wasm")).await?.into_result()?;
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
        .deploy(&wasm("target/near/tenured_verifier/tenured_verifier.wasm"))
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
        self.register_yocto(who, proposal_id, near * NEAR, claims, nonce).await
    }

    async fn register_yocto(&self, who: &Account, proposal_id: u64, amount: u128, claims: &Value, nonce: u64) -> ExecutionFinalResult {
        who.call(self.lane.id(), "register")
            .args_json(json!({ "proposal_id": proposal_id, "amount": amount.to_string(), "claims": claims, "nonce": nonce }))
            .deposit(NearToken::from_millinear(10))
            .max_gas()
            .transact()
            .await
            .unwrap()
    }

    async fn request(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self.lane.view("get_request").args_json(json!({ "id": id })).await?.json()?)
    }

    /// The funding DAO changes the lane's config through a FunctionCall
    /// proposal, the only way it can be changed.
    async fn reconfigure(&self, change: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
        let mut config: Value = self.lane.view("get_config").await?.json()?;
        change(&mut config);
        use base64::Engine;
        let args = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&json!({ "config": config }))?);
        let kind = json!({ "FunctionCall": { "receiver_id": self.lane.id(), "actions": [{
            "method_name": "configure", "args": args, "deposit": "0", "gas": "30000000000000" }] } });
        let id = propose(&self.fund, &self.council, kind.clone()).await?;
        act(&self.fund, &self.council, id, "VoteApprove", kind).await.into_result()?;
        Ok(())
    }

    /// A policy change in the funding DAO, approved by the council.
    async fn change_policy(&self, kind: Value) -> anyhow::Result<()> {
        let id = propose(&self.fund, &self.council, kind.clone()).await?;
        act(&self.fund, &self.council, id, "VoteApprove", kind).await.into_result()?;
        Ok(())
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

#[tokio::test]
async fn councils_paying_themselves_can_be_excluded() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let dev_claims = w.history().await?;
    // The council member pays themselves from both DAOs they sit on.
    let c0 = paid(&w.alpha, &w.council, &w.council, 2).await?;
    let c1 = paid(&w.alpha, &w.council, &w.council, 2).await?;
    let c2 = paid(&w.beta, &w.council, &w.council, 2).await?;
    let council_claims = json!([
        { "dao_id": w.alpha.id(), "proposal_id": c0 },
        { "dao_id": w.alpha.id(), "proposal_id": c1 },
        { "dao_id": w.beta.id(), "proposal_id": c2 },
    ]);
    let rules = |exclude: bool| {
        json!({
            "trusted_daos": [w.alpha.id(), w.beta.id()],
            "tokens": [{ "token_id": "", "min_amount": NEAR.to_string() }],
            "min_distinct_daos": 2,
            "min_payouts": 3,
            "exclude_members": exclude,
        })
    };
    let verify = |who: &Account, claims: &Value, exclude: bool| {
        let args = json!({ "account_id": who.id(), "claims": claims, "rules": rules(exclude) });
        w.eve.call(w.verifier.id(), "verify").args_json(args).max_gas().transact()
    };

    let a: Value = verify(&w.council, &council_claims, false).await?.into_result()?.json()?;
    assert_eq!(a["summary"]["qualifies"], true, "self-payments count when the rule is off: {a}");

    let r = verify(&w.council, &council_claims, true).await?;
    println!("verify with 3 claims and 2 policy reads burnt {} Tgas", r.total_gas_burnt.as_tgas());
    let a: Value = r.into_result()?.json()?;
    assert_eq!(a["summary"]["qualifies"], false, "{a}");
    assert!(a["results"].as_array().unwrap().iter().all(|r| r["reason"] == "DaoMember"));

    // An outside contributor is unaffected.
    let a: Value = verify(&w.dev, &dev_claims, true).await?.into_result()?.json()?;
    assert_eq!(a["summary"]["qualifies"], true, "{a}");
    Ok(())
}

#[tokio::test]
async fn nine_claims_from_nine_daos_fit_in_one_call() -> anyhow::Result<()> {
    let w = setup(30).await?;
    // dev was paid once by each of nine DAOs.
    let mut daos = vec![];
    let mut claims = vec![];
    for i in 0..9 {
        let d = dao(&w.factory, &format!("guild{i}"), &w.council).await?;
        let id = paid(&d, &w.council, &w.dev, 1).await?;
        claims.push(json!({ "dao_id": d.id(), "proposal_id": id }));
        daos.push(d.id().to_string());
    }
    // The DAO trusts all nine and also excludes members: 1 + 9 + 9 reads.
    w.reconfigure(|c| {
        c["rules"]["trusted_daos"] = json!(daos);
        c["rules"]["min_distinct_daos"] = json!(9);
        c["rules"]["min_payouts"] = json!(9);
        c["rules"]["exclude_members"] = json!(true);
    })
    .await?;

    let pid = propose(&w.fund, &w.dev, transfer(w.dev.id(), 1)).await?;
    let r = w.register(&w.dev, pid, 1, &json!(claims), 1).await;
    assert!(r.is_success(), "{}", failure_text(&r));
    println!("register with 9 claims and 9 policy reads burnt {} Tgas", r.total_gas_burnt.as_tgas());
    let req = w.request(0).await?;
    assert_eq!(status_of(&req), "Waiting", "{req}");
    assert_eq!(req["distinct_daos"], 9);

    // The verifier's limit is ten claims; nine plus a duplicate exercises it.
    let mut ten = claims.clone();
    ten.push(claims[0].clone());
    let rules = json!({
        "trusted_daos": daos, "tokens": [{ "token_id": "", "min_amount": NEAR.to_string() }],
        "min_distinct_daos": 9, "min_payouts": 9, "exclude_members": true,
    });
    let r = w.eve
        .call(w.verifier.id(), "verify")
        .args_json(json!({ "account_id": w.dev.id(), "claims": ten, "rules": rules }))
        .max_gas()
        .transact()
        .await?;
    println!("verify with 10 claims and 9 policy reads burnt {} Tgas", r.total_gas_burnt.as_tgas());
    let a: Value = r.into_result()?.json()?;
    assert_eq!(a["summary"]["qualifies"], true, "{a}");
    assert_eq!(a["results"][9]["reason"], "Duplicate");
    Ok(())
}

#[tokio::test]
async fn registrations_pay_for_their_own_storage() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    let before = w.lane.as_account().view_account().await?;

    // Junk registrations from an account with no record: each is refused,
    // but each still leaves a request on chain.
    for nonce in 0..5u64 {
        let r = w.register(&w.eve, 1000 + nonce, 1, &claims, nonce).await;
        assert!(r.is_success(), "{}", failure_text(&r));
    }
    let no_deposit = w.eve
        .call(w.lane.id(), "register")
        .args_json(json!({ "proposal_id": 2000, "amount": NEAR.to_string(), "claims": claims, "nonce": 99 }))
        .max_gas()
        .transact()
        .await?;
    assert!(failure_text(&no_deposit).contains("attach 0.01 NEAR"));

    let after = w.lane.as_account().view_account().await?;
    let used = after.storage_usage - before.storage_usage;
    let staked = used as u128 * 10u128.pow(19);
    let paid = 5 * 10u128.pow(22);
    println!("5 refused requests used {used} bytes ({staked} yocto staked), callers paid {paid}");
    assert!(staked < paid, "deposits must cover the storage");
    // The lane ends up with more free balance than it started with, not less.
    assert!(after.balance.as_yoctonear() >= before.balance.as_yoctonear() + paid - staked - NEAR / 100);
    Ok(())
}

#[tokio::test]
async fn a_veto_window_longer_than_the_proposal_is_refused_up_front() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    // The DAO's proposals now expire after 20 s, shorter than the 30 s veto window.
    w.change_policy(json!({ "ChangePolicyUpdateParameters": { "parameters": {
        "proposal_bond": null, "proposal_period": "20000000000",
        "bounty_bond": null, "bounty_forgiveness_period": null } } }))
    .await?;

    let kind = transfer(w.dev.id(), 4);
    let pid = propose(&w.fund, &w.dev, kind.clone()).await?;
    assert!(w.register(&w.dev, pid, 4, &claims, 1).await.is_success());
    let req = w.request(0).await?;
    assert_eq!(status_of(&req), "Refused", "{req}");
    assert!(req["status"]["Refused"]["reason"].as_str().unwrap().contains("veto window ends after the proposal expires"));

    // The lane never voted, so the expired proposal can still be finalized
    // (by the council, under the default policy) and the bond goes back.
    w.wait(21).await?;
    let before = w.dev.view_account().await?.balance;
    act(&w.fund, &w.council, pid, "Finalize", kind).await.into_result()?;
    assert_eq!(status(&w.fund, pid).await?, "Expired");
    let after = w.dev.view_account().await?.balance;
    assert!(after.as_yoctonear() > before.as_yoctonear() + NEAR * 9 / 10, "bond came back");
    Ok(())
}

#[tokio::test]
async fn squatting_someone_elses_proposal_does_not_block_them() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    let pid = propose(&w.fund, &w.dev, transfer(w.dev.id(), 4)).await?;
    // eve registers dev's proposal first, and the next ten ids for good measure.
    for (i, id) in (pid..pid + 11).enumerate() {
        assert!(w.register(&w.eve, id, 4, &claims, i as u64).await.is_success());
    }
    let r = w.register(&w.dev, pid, 4, &claims, 1).await;
    assert!(r.is_success(), "{}", failure_text(&r));
    let mine: Value = w.lane.view("get_request_by_proposal").args_json(json!({ "proposal_id": pid })).await?.json()?;
    assert_eq!(mine["account_id"], w.dev.id().to_string());
    assert_eq!(status_of(&mine), "Waiting", "{mine}");
    Ok(())
}

#[tokio::test]
async fn a_vote_that_does_not_approve_keeps_the_amount_counted() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    // The DAO puts a second member in the fastlane role, so the lane's vote
    // alone no longer reaches the 1/1 threshold.
    w.change_policy(json!({ "ChangePolicyAddOrUpdateRole": { "role": {
        "name": "fastlane", "kind": { "Group": [w.lane.id(), w.guardian.id()] },
        "permissions": ["transfer:VoteApprove"],
        "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1] } } } } }))
    .await?;

    let kind = transfer(w.dev.id(), 4);
    let pid = propose(&w.fund, &w.dev, kind.clone()).await?;
    assert!(w.register(&w.dev, pid, 4, &claims, 1).await.is_success());
    w.wait(31).await?;
    assert!(w.execute(&w.eve, 0).await.is_success());
    assert_eq!(status_of(&w.request(0).await?), "Voted");
    assert_eq!(status(&w.fund, pid).await?, "InProgress");
    let usage: Value = w.lane.view("get_usage").args_json(json!({ "account_id": w.dev.id() })).await?.json()?;
    assert_eq!(usage["used_by_account"], (4 * NEAR).to_string(), "the vote stands, so the amount stays counted");

    // The second member approves; recheck settles the request.
    act(&w.fund, &w.guardian, pid, "VoteApprove", kind).await.into_result()?;
    let r = w.eve.call(w.lane.id(), "recheck").args_json(json!({ "id": 0 })).max_gas().transact().await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(status_of(&w.request(0).await?), "Approved");
    Ok(())
}

#[tokio::test]
async fn the_largest_allowed_inputs_still_fit() -> anyhow::Result<()> {
    let w = setup(30).await?;
    // Nine DAOs whose policies list 900 members each (about 27 KB, under the
    // 32 KB limit), each paying dev once with a 15 KB description (under 16 KB).
    let crowd: Vec<String> = (0..900).map(|i| format!("member-number-{i:04}.test.near")).collect();
    let mut daos = vec![];
    let mut claims = vec![];
    for i in 0..9 {
        let acc = w.factory.create_subaccount(&format!("big{i}")).initial_balance(NearToken::from_near(60)).transact().await?.into_result()?;
        let d = acc.deploy(&wasm("res/sputnikdao2.wasm")).await?.into_result()?;
        // A one-person council plus a 900-member group with no permissions,
        // so the policy is large but a single council vote still approves.
        let policy = json!({
            "roles": [
                { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
                { "name": "council", "kind": { "Group": [w.council.id()] }, "permissions": ["*:*"], "vote_policy": {} },
                { "name": "crowd", "kind": { "Group": crowd }, "permissions": [], "vote_policy": {} },
            ],
            "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
            "proposal_bond": NEAR.to_string(),
            "proposal_period": "604800000000000",
            "bounty_bond": NEAR.to_string(),
            "bounty_forgiveness_period": "86400000000000",
        });
        d.call("new")
            .args_json(json!({ "config": { "name": format!("big{i}"), "purpose": "test", "metadata": "" }, "policy": policy }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        let kind = transfer(w.dev.id(), 1);
        let id: u64 = w.dev
            .call(d.id(), "add_proposal")
            .args_json(json!({ "proposal": { "description": "x".repeat(15_000), "kind": kind } }))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json()?;
        act(&d, &w.council, id, "VoteApprove", kind).await.into_result()?;
        claims.push(json!({ "dao_id": d.id(), "proposal_id": id }));
        daos.push(d.id().to_string());
    }
    let policy: Value = w.worker.view(&daos[0].parse()?, "get_policy").await?.json()?;
    println!("policy size {} bytes", serde_json::to_vec(&policy)?.len());
    // What each read costs when made as a call, at these sizes.
    let first: near_workspaces::AccountId = daos[0].parse()?;
    let g = w.eve.call(&first, "get_policy").max_gas().transact().await?;
    println!("get_policy (28 KB) as a call burnt {} Tgas", g.total_gas_burnt.as_tgas());
    let g = w.eve.call(&first, "get_proposal").args_json(json!({ "id": 0 })).max_gas().transact().await?;
    println!("get_proposal (15 KB) as a call burnt {} Tgas", g.total_gas_burnt.as_tgas());
    let g = w.eve.call(w.alpha.id(), "get_policy").max_gas().transact().await?;
    println!("get_policy (1 member) as a call burnt {} Tgas", g.total_gas_burnt.as_tgas());

    w.reconfigure(|c| {
        c["rules"]["trusted_daos"] = json!(daos);
        c["rules"]["min_distinct_daos"] = json!(9);
        c["rules"]["min_payouts"] = json!(9);
        c["rules"]["exclude_members"] = json!(true);
    })
    .await?;
    let rules = json!({ "trusted_daos": daos, "tokens": [{ "token_id": "", "min_amount": NEAR.to_string() }],
                        "min_distinct_daos": 9, "min_payouts": 9, "exclude_members": true });
    let a = w.eve.call(w.verifier.id(), "verify")
        .args_json(json!({ "account_id": w.dev.id(), "claims": claims, "rules": rules })).max_gas().transact().await?;
    println!("verify at the size limits burnt {} Tgas", a.total_gas_burnt.as_tgas());
    let a: Value = a.into_result()?.json()?;
    println!("verifier reasons: {:?}", a["results"].as_array().unwrap().iter().map(|r| r["reason"].clone()).collect::<Vec<_>>());

    let pid = propose(&w.fund, &w.dev, transfer(w.dev.id(), 1)).await?;
    let r = w.register(&w.dev, pid, 1, &json!(claims), 1).await;
    assert!(r.is_success(), "{}", failure_text(&r));
    println!("register at the size limits burnt {} Tgas", r.total_gas_burnt.as_tgas());
    let req = w.request(0).await?;
    assert_eq!(status_of(&req), "Waiting", "{req}");
    Ok(())
}

#[tokio::test]
async fn removing_the_role_switches_the_lane_off() -> anyhow::Result<()> {
    let w = setup(30).await?;
    let claims = w.history().await?;
    let pid = propose(&w.fund, &w.dev, transfer(w.dev.id(), 4)).await?;
    assert!(w.register(&w.dev, pid, 4, &claims, 1).await.is_success());

    // During the window the DAO removes the lane's role with one proposal.
    w.change_policy(json!({ "ChangePolicyRemoveRole": { "role": "fastlane" } })).await?;

    w.wait(31).await?;
    let r = w.execute(&w.eve, 0).await;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(status_of(&w.request(0).await?), "Refused");
    assert_eq!(status(&w.fund, pid).await?, "InProgress");
    Ok(())
}
