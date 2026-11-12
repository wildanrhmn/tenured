#!/usr/bin/env bash
# Runs the fast lane on testnet, step by step.
#
#   ./scripts/testnet-demo.sh request 0.5   # dev files a 0.5 NEAR proposal and registers it
#   ./scripts/testnet-demo.sh status        # every lane request
#   ./scripts/testnet-demo.sh execute <id>  # after the veto window; anyone can call it
#   ./scripts/testnet-demo.sh veto <id>     # as the guardian, during the window
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
  *)
    sed -n '2,10p' "$0"
    ;;
esac
