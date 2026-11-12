#!/usr/bin/env bash
# Sets up the full Track Record demo on testnet, using only the near CLI.
#
#   1. three Sputnik DAOs from the real testnet factory (sputnikv2.testnet):
#      alpha and beta (where the contributor has past paid work) and fund
#      (the DAO that installs the fast lane)
#   2. the verifier and lane contracts
#   3. a real payout history: alpha pays dev twice, beta once
#   4. the lane installed in fund through an ordinary DAO proposal
#
# Accounts are expected in ~/.near-credentials (legacy keychain). Create
# them for free with:
#   near account create-account sponsor-by-faucet-service <name>.testnet \
#     autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
#
# Override names with env vars; defaults are the ones the README links to.

set -euo pipefail
cd "$(dirname "$0")/.."

P=${PREFIX:-trackrecord}
FACTORY=sputnikv2.testnet
COUNCIL=${COUNCIL:-$P-council.testnet}
DEV=${DEV:-$P-dev.testnet}
GUARDIAN=${GUARDIAN:-$P-guardian.testnet}
LANE=${LANE:-$P-lane.testnet}
VERIFIER=${VERIFIER:-$P-verifier.testnet}
ALPHA=$P-alpha.$FACTORY
BETA=$P-beta.$FACTORY
FUND=$P-fund.$FACTORY
NEAR_YOCTO=1000000000000000000000000
VETO_SECS=${VETO_SECS:-600}

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

call() { # call <signer> <contract> <method> <json> <deposit> [gas]
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-150.0 Tgas}" attached-deposit "$5" \
    sign-as "$1" network-config testnet sign-with-legacy-keychain send
}

view() { # view <contract> <method> <json>
  near contract call-function as-read-only "$1" "$2" json-args "$3" network-config testnet now 2>/dev/null
}

exists() { near account view-account-summary "$1" network-config testnet now >/dev/null 2>&1; }

last_id() { view "$1" get_last_proposal_id '{}' | tail -1 | tr -d '[:space:]'; }

# propose <dao> <signer> <kind-json> -> prints the new proposal id
propose() {
  local id
  id=$(last_id "$1")
  call "$2" "$1" add_proposal "{\"proposal\":{\"description\":\"${4:-Track Record demo}\",\"kind\":$3}}" '1 NEAR' >/dev/null
  echo "$id"
}

approve() { # approve <dao> <id> <kind-json>
  call "$COUNCIL" "$1" act_proposal "{\"id\":$2,\"action\":\"VoteApprove\",\"proposal\":$3}" '0 NEAR' '200.0 Tgas' >/dev/null
}

transfer_kind() { # transfer_kind <receiver> <near amount as yocto string>
  echo "{\"Transfer\":{\"token_id\":\"\",\"receiver_id\":\"$1\",\"amount\":\"$2\",\"msg\":null}}"
}

echo "== 1. DAOs from $FACTORY"
for pair in "alpha:$P-fund1.testnet" "beta:$P-fund2.testnet" "fund:$P-fund3.testnet"; do
  name=${pair%%:*}
  payer=${pair#*:}
  dao=$P-$name.$FACTORY
  if exists "$dao"; then echo "   $dao exists"; continue; fi
  args=$(b64 "{\"config\":{\"name\":\"$P-$name\",\"purpose\":\"Track Record demo DAO\",\"metadata\":\"\"},\"policy\":[\"$COUNCIL\"]}")
  call "$payer" "$FACTORY" create "{\"name\":\"$P-$name\",\"args\":\"$args\"}" '9 NEAR' '200.0 Tgas' >/dev/null
  echo "   created $dao"
done

echo "== 2. contracts"
./scripts/build-contracts.sh >/dev/null
if [ -z "$(view "$VERIFIER" factory '{}' || true)" ]; then
  near contract deploy "$VERIFIER" use-file contracts/target/near/track_record_verifier/track_record_verifier.wasm \
    with-init-call new json-args "{\"factory\":\"$FACTORY\"}" prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    network-config testnet sign-with-legacy-keychain send >/dev/null
  echo "   deployed verifier at $VERIFIER"
else
  echo "   verifier already at $VERIFIER"
fi

LANE_CONFIG=$(cat <<EOF
{"rules":{"trusted_daos":["$ALPHA","$BETA"],
          "tokens":[{"token_id":"","min_amount":"100000000000000000000000"}],
          "min_distinct_daos":2,"min_payouts":3},
 "pay_token":"",
 "per_account_cap":"1000000000000000000000000",
 "period_budget":"2000000000000000000000000",
 "period_secs":2592000,"veto_secs":$VETO_SECS,"max_proposal_age_secs":259200,
 "guardians":["$GUARDIAN"]}
EOF
)
if [ -z "$(view "$LANE" get_dao '{}' || true)" ]; then
  near contract deploy "$LANE" use-file contracts/target/near/track_record_lane/track_record_lane.wasm \
    with-init-call new json-args "{\"dao\":\"$FUND\",\"factory\":\"$FACTORY\",\"config\":$LANE_CONFIG}" \
    prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send >/dev/null
  echo "   deployed lane at $LANE for $FUND"
else
  echo "   lane already at $LANE"
fi

echo "== 3. payout history for $DEV"
if [ "$(last_id "$ALPHA")" = "0" ]; then
  for dao_amt in "$ALPHA:0.5" "$ALPHA:0.3" "$BETA:0.4"; do
    dao=${dao_amt%%:*}
    amt=$(python3 -c "print(int(float('${dao_amt#*:}') * 10**24))")
    kind=$(transfer_kind "$DEV" "$amt")
    id=$(propose "$dao" "$DEV" "$kind" "Contributor payout")
    approve "$dao" "$id" "$kind"
    echo "   $dao#$id paid ${dao_amt#*:} NEAR to $DEV"
  done
else
  echo "   history already there"
fi

echo "== 4. install the lane in $FUND"
ROLE="{\"ChangePolicyAddOrUpdateRole\":{\"role\":{\"name\":\"fastlane\",\"kind\":{\"Group\":[\"$LANE\"]},\"permissions\":[\"transfer:VoteApprove\"],\"vote_policy\":{\"transfer\":{\"weight_kind\":\"RoleWeight\",\"quorum\":\"0\",\"threshold\":[1,1]}}}}}"
if view "$FUND" get_policy '{}' | grep -q fastlane; then
  echo "   fastlane role already installed"
else
  id=$(propose "$FUND" "$COUNCIL" "$ROLE" "Install the Track Record fast lane")
  approve "$FUND" "$id" "$ROLE"
  echo "   installed via $FUND#$id"
fi

echo
echo "done. Try it:"
echo "  npm run cli -- verify $DEV --network testnet --trust $ALPHA,$BETA --claims $ALPHA#0,$ALPHA#1,$BETA#0 --min-near 0.1"
echo "  ./scripts/testnet-demo.sh"
