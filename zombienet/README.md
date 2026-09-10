# Uniswap v3 on a local HydraDX zombienet

Deploys the full Uniswap v3 stack (factory, NonfungiblePositionManager,
SwapRouter02, QuoterV2, TickLens, Migrator, Staker, Multicall2) onto a local
HydraDX parachain running under zombienet, using this repo's `@uniswap/deploy-v3`
CLI over the node's Frontier EVM JSON-RPC.

This is **phase 1**. Phase 2 (Gamma ALM vault + LP/swap smoke test) lives in the
sibling `gamma-hypervisor/zombienet/` and consumes the addresses written here.

## Layout assumption

These repos must be siblings under one parent (they already are):

```
<parent>/
  hydration-node/      # provides target/release/hydradx + the `local` chain
  polkadot-sdk/        # provides target/release/polkadot (relay)
  uniswap-v3-deploy/   # this repo
  gamma-hypervisor/    # phase 2
```

## Prerequisites

- `hydration-node/target/release/hydradx` — `cd ../hydration-node && cargo build --release`
- `polkadot-sdk/target/release/polkadot`
- `zombienet` on PATH — `npm i -g @nicedotfun/zombienet`
- Node 18+ (uses the global `fetch`); this repo's deps installed (`yarn install` in the repo root)
- These scripts' deps: `cd zombienet && npm install`

## The two HydraDX-specific gotchas (why this isn't a vanilla EVM deploy)

1. **Gas is paid in WETH (asset 20), not a native ETH balance.** The chain spec
   registers WETH and funds the deployer; `setup.js` then sets WETH's XCM
   location and marks it an accepted fee currency (via a 1-block GeneralAdmin
   referendum, enabled by `Parameters::IsTestnet=true`). Only then does the
   deployer's EVM balance become non-zero and gas work.
2. **Contract creation is permissioned.** The deployer EVM address is whitelisted
   in `EVMAccounts::ContractDeployer` (injected into raw genesis by `chainspec.js`).

## Accounts & tokens

| Thing | Value |
| --- | --- |
| Deployer EVM | `0xC19A2970A13ac19898c47d59Cbd0278D428EBC7c` (Charlie's EVM key) |
| Deployer substrate (gas/balances) | `5DdcCSDqrt3ThGfhqr63psaauSd1HZPpXEmWcNdiggzkXehL` |
| WETH (gas) | asset 20 → `0x0000000000000000000000000000000100000014` |
| KSM (pool token0) | asset 1 → `0x0000000000000000000000000000000100000001` |
| KUSD (pool token1) | asset 2 → `0x0000000000000000000000000000000100000002` |
| EVM RPC | `http://127.0.0.1:9999` · chainId `2222222` |

The deployer key is a well-known public dev key — **local testing only.**

## Run it

```bash
cd zombienet
npm install
npm run e2e          # build spec → spawn (background) → setup → deploy
npm run stop         # tear the chain down when done (after phase 2)
```

`npm run e2e` leaves the chain running so phase 2 can use it.

## Output

`deployments/zombienet.json` — network params, deployer, token precompile
addresses, and every deployed Uniswap v3 contract. Phase 2 reads this file.

## Scripts (all Node, no shell)

| Command | File | Does |
| --- | --- | --- |
| `npm run chainspec` | `chainspec.js` | plain `local` spec → patch genesis (WETH, funded deployer, TC, para id) → raw → inject IsTestnet + ContractDeployer |
| `npm run setup` | `setup.js` | WETH location + accepted fee currency (1-block referendum) |
| `npm run deploy` | `deploy.js` | run `@uniswap/deploy-v3` CLI (`-c 1`, WETH9 = asset-20 precompile) → write `deployments/zombienet.json` |
| `npm run e2e` | `e2e.js` | chainspec → spawn zombienet → wait → setup → deploy |
| `npm run stop` | `e2e.js stop` | tear down the background zombienet |

Each step is independently runnable; `e2e.js` just calls them in order.

## Notes

- The router's `WETH9` is the WETH asset-20 precompile. Our pools are KSM/KUSD,
  which never exercise native-ETH wrapping, so a standalone WETH9 is unnecessary.
- `-c 1` waits one block per step so contract addresses resolve from receipts;
  the parachain auto-authors (`--force-authoring`) every ~6–12s.
