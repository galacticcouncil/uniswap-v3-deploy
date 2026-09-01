#!/usr/bin/env bash
#
# Deploy the EVM portion of the production launch. Governance is intentionally
# not submitted here: this script prints the final proposal and stops, so the
# signer/operator can review the exact live-runtime encoding before submission.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export ENV_FILE="${ENV_FILE:-.env.mainnet}"
[ -f "$ENV_FILE" ] || { echo "ERROR: configuration file not found: $ENV_FILE" >&2; exit 1; }

step() { printf '\n========== %s ==========\n' "$*"; }

step "1/4 preflight"
node 00-preflight.js

step "2/4 deploy Uniswap v3 contracts"
node 02-deploy.js

step "3/4 create and initialize the pool"
node 03-create-pool.js

step "4/4 print the governance launch proposal"
node 01-governance-calldata.js launch

cat <<'EOF'

Direct EVM deployment is complete. No governance transaction was submitted.

Next:
  1. Review and submit the printed proposal.
  2. After enactment, run: ENV_FILE=<this file> npm run verify
  3. Wait for real TWAP history before the separate Gamma seed deployment.
EOF
