#!/usr/bin/env bash
#
# Launch ONE more pool on the live, registered factory (pools 2-5): preflight,
# create and initialize it, then print its governance proposal. Nothing is
# submitted and no v3 contract is deployed.
#
#   ENV_FILE=.env.pools ./launch-pool.sh pools/atbtc-hollar.env

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export ENV_FILE="${ENV_FILE:-.env.pools}"
export POOL_FILE="${1:?usage: ./launch-pool.sh pools/<name>.env}"
[ -f "$ENV_FILE" ] || { echo "ERROR: shared configuration not found: $ENV_FILE" >&2; exit 1; }
[ -f "$POOL_FILE" ] || { echo "ERROR: pool configuration not found: $POOL_FILE" >&2; exit 1; }

step() { printf '\n========== %s ==========\n' "$*"; }

step "1/3 preflight ($POOL_FILE)"
node 00-preflight.js

step "2/3 create and initialize the pool"
node 03-create-pool.js

step "3/3 print this pool's governance proposal"
node 01-governance-calldata.js pool

cat <<'EOF'

The pool is created and empty. No governance transaction was submitted.

Next:
  1. Submit the printed proposal on its track (one referendum per pool).
  2. After enactment: ENV_FILE=<shared> POOL_FILE=<pool> npm run verify
  3. Continue with the Gamma vault in gamma-hypervisor/mainnet.
EOF
