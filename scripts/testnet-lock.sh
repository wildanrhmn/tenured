#!/usr/bin/env bash
# Locks the lane: deletes every full-access key on its account. Afterwards
# nobody can change the lane's code or move anything from it; only its DAO
# can change its config, through configure(). This cannot be undone.
#
#   ./scripts/testnet-lock.sh --yes
#
# Run it only after the final code is deployed (scripts/testnet-setup.sh).

set -euo pipefail
LANE=${LANE:-${PREFIX:-trackrecord}-lane.testnet}
[ "${1:-}" = "--yes" ] || { echo "This permanently locks $LANE. Re-run with --yes."; exit 1; }

keys=$(near account list-keys "$LANE" network-config testnet now 2>&1 | grep 'full access' | grep -oE 'ed25519:[1-9A-HJ-NP-Za-km-z]+' || true)
[ -n "$keys" ] || { echo "$LANE has no full-access keys; already locked."; exit 0; }
for k in $keys; do
  echo "deleting $k from $LANE"
  near account delete-keys "$LANE" public-keys "$k" network-config testnet sign-with-legacy-keychain send 2>&1 | grep -E 'Transaction ID|deleted|rror' || true
done
near account list-keys "$LANE" network-config testnet now 2>&1 | grep -c 'full access' | xargs -I{} echo "full-access keys left on $LANE: {}"
