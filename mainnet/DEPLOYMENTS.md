# Deployment records

No testnet or historical addresses are committed here. Each launch writes its
own ignored records under `mainnet/deployments/`:

- `<net>-state.json` — resumable upstream deploy-v3 migration state.
- `<net>.json` — final v3 address sheet, owner, RPC and chain ID.
- `<net>-pool.json` — launch-pool address, token order, initialization and TWAP
  settings.

Before handoff, archive those files with the reviewed configuration (excluding
`DEPLOYER_PK`), governance preimage/hash, referendum index, enactment blocks,
and the successful `04-verify.js` output.
