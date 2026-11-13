#!/usr/bin/env bash
# Runs the fast lane on testnet, step by step.
#
#   ./scripts/testnet-demo.sh request 0.5   # dev files a 0.5 NEAR proposal and registers it
#   ./scripts/testnet-demo.sh status        # every lane request
#   ./scripts/testnet-demo.sh execute <id>  # after the veto window; anyone can call it
#   ./scripts/testnet-demo.sh veto <id>     # as the guardian, during the window
#   ./scripts/testnet-demo.sh exclude-members true|false
#                                           # the DAO changes the lane's config by proposal
#
# Run ./scripts/testnet-setup.sh first.

set -euo pipefail
P=${PREFIX:-trackrecord}
FACTORY=sputnikv2.testnet
DEV=${DEV:-$P-dev.testnet}
GUARDIAN=${GUARDIAN:-$P-guardian.testnet}
CALLER=${CALLER:-$P-council.testnet}
LANE=${LANE:-$P-lane.testnet}
ALPHA=$P-alpha.$FACTORY
BETA=$P-beta.$FACTORY
FUND=$P-fund.$FACTORY

call() {
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-300.0 Tgas}" attached-deposit "$5" \
    sign-as "$1" network-config testnet sign-with-legacy-keychain send 2>&1 |
    grep -E 'Transaction ID|EVENT_JSON|succeeded|Error|error|panicked' || true
}
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" network-config testnet now 2>/dev/null; }

case "${1:-}" in
  request)
    amount=$(python3 -c "from decimal import Decimal; print(int(Decimal('${2:-0.5}') * 10**24))")
    id=$(view "$FUND" get_last_proposal_id '{}' | tail -1 | tr -d '[:space:]')
    echo "== $DEV files an ordinary Transfer proposal in $FUND (#$id)"
    call "$DEV" "$FUND" add_proposal \
      "{\"proposal\":{\"description\":\"Fast lane payout\",\"kind\":{\"Transfer\":{\"token_id\":\"\",\"receiver_id\":\"$DEV\",\"amount\":\"$amount\"}}}}" '1 NEAR'
    echo "== $DEV registers it with the lane, presenting three past payouts"
    nonce=$(date +%s)
    call "$DEV" "$LANE" register \
      "{\"proposal_id\":$id,\"amount\":\"$amount\",\"nonce\":$nonce,\"claims\":[{\"dao_id\":\"$ALPHA\",\"proposal_id\":0},{\"dao_id\":\"$ALPHA\",\"proposal_id\":1},{\"dao_id\":\"$BETA\",\"proposal_id\":0}]}" '0 NEAR'
    view "$LANE" get_request_by_proposal "{\"proposal_id\":$id}"
    ;;
  status)
    view "$LANE" get_requests '{"from_index":0,"limit":50}'
    ;;
  execute)
    call "$CALLER" "$LANE" execute "{\"id\":$2}" '0 NEAR'
    view "$LANE" get_request "{\"id\":$2}"
    ;;
  veto)
    call "$GUARDIAN" "$LANE" veto "{\"id\":$2}" '0 NEAR' '30.0 Tgas'
    view "$LANE" get_request "{\"id\":$2}"
    ;;
  exclude-members)
    # Only the DAO can configure the lane, so this goes through a normal
    # FunctionCall proposal that the council approves.
    COUNCIL=${COUNCIL:-$P-council.testnet}
    cfg=$(view "$LANE" get_config '{}' | python3 -c "import json,sys;c=json.load(sys.stdin);c['rules']['exclude_members']=('${2:-true}'=='true');print(json.dumps({'config':c},separators=(',',':')))")
    kind="{\"FunctionCall\":{\"receiver_id\":\"$LANE\",\"actions\":[{\"method_name\":\"configure\",\"args\":\"$(printf '%s' "$cfg" | base64 | tr -d '\n')\",\"deposit\":\"0\",\"gas\":\"30000000000000\"}]}}"
    id=$(view "$FUND" get_last_proposal_id '{}' | tail -1 | tr -d '[:space:]')
    echo "== $COUNCIL proposes the new config (#$id) and approves it"
    call "$COUNCIL" "$FUND" add_proposal "{\"proposal\":{\"description\":\"Lane: exclude_members=${2:-true}\",\"kind\":$kind}}" '1 NEAR' '50.0 Tgas'
    call "$COUNCIL" "$FUND" act_proposal "{\"id\":$id,\"action\":\"VoteApprove\",\"proposal\":$kind}" '0 NEAR' '200.0 Tgas'
    view "$LANE" get_config '{}' | grep exclude_members
    ;;
  *)
    sed -n '2,10p' "$0"
    ;;
esac
