# Uniswap v3 launch scripts (mainnet / lark)

Production counterpart of `zombienet/`: gets the v3 stack from zero to a live,
oracle-priced, TWAP-ready pool on a real Hydration network. Liquidity seeding is
**not** here — that goes through the Gamma UniProxy (`gamma-hypervisor` repo),
so the ClearingV2 deposit guards apply.

```bash
cd mainnet
npm install
cp .env.example .env   # fill in DEPLOYER_PK etc.
```

## Order of operations

| # | Command | What / who executes |
| --- | --- | --- |
| 1 | `node 01-governance-calldata.js whitelist` | prints `evmAccounts.addContractDeployer` calldata → referendum (ControllerOrigin) |
| 2 | `node 00-preflight.js` | read-only: chain, whitelist, WETH gas, assets, DIA feed |
| 3 | `node 02-deploy.js` | runs the repo CLI (~14 txs), writes `deployments/<net>.json` |
| 4 | `node 03-create-pool.js` | create + `initialize` at DIA price + grow observation cardinality |
| 5 | *(gamma-hypervisor)* | Hypervisor + UniProxy/ClearingV2, vault seeding |
| 6 | `node 01-governance-calldata.js set-addresses` | `parameters.setUniswapV3Addresses` calldata → Root referendum (needs PR [#1477](https://github.com/galacticcouncil/hydration-node/pull/1477) runtime) |
| 7 | `node 04-owner-ops.js transfer-owner <governance-evm>` | hand factory off governance |
| 8 | `node 04-owner-ops.js set-fee-protocol <pool> 0 0` | later: flip to `4 4` (25%) once organic flow arrives |

On **lark** the governance calls can instead be auto-submitted by
`hydration-node/scripts/uniswap-v3-lark` (fast-track root referenda); these
scripts still work there with `NET=lark` and the lark RPC urls.

## Why 03-create-pool.js exists

- A v3 pool starts priceless; `initialize(sqrtPriceX96)` sets the first price.
  A wrong init price is free money for the first arber, so the price comes from
  DIA (with optional manual cross-check that aborts on divergence).
- The observation ring buffer starts at cardinality 1 → no TWAP → ClearingV2's
  deposit guard and the keeper's TWAP gates can't function. We grow it to
  `OBS_CARDINALITY` (600 ≈ 1h at 6s blocks) in chunks, since every new slot is
  an SSTORE and one big jump can blow the block gas limit.
- Slots only fill as swaps touch new blocks — expect the full TWAP window to be
  meaningful only after some trading activity.

## Asset cheat sheet (mainnet)

| Asset | id | precompile |
| --- | --- | --- |
| WETH (gas) | 20 | `0x0000000000000000000000000000000100000014` |
| DOT | 5 | `0x0000000000000000000000000000000100000005` |
| HOLLAR | 222 | `0x00000000000000000000000000000001000000de` |

Decimals differ (DOT 10, HOLLAR 18) — the price math in `lib.js` is
decimals-aware; `PRICE`/DIA values are always human units (HOLLAR per DOT).

## Notes

- Gas is paid in WETH (asset 20); `eth_getBalance` == WETH balance.
- The router's `WETH9` is the asset-20 precompile. It does **not** implement
  `deposit`/`withdraw`, so native-value paths (`unwrapWETH9`, `refundETH`,
  msg.value multicalls) must never be used by integrations.
- `04-owner-ops.js` sends directly while the deploy key still owns the factory,
  and prints raw `{to, data}` for governance `evm.call` wrapping after handoff.
