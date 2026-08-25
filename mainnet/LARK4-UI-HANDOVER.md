# lark4 — Uniswap v3 + Gamma ALM deployed addresses (UI handover)

Everything a frontend needs to talk to the Uniswap v3 / Gamma stack on the **lark4**
Hydration fork. Verified on-chain 2026-08-25.

## Network

| | |
|---|---|
| Name | Lark 4 Hydration |
| EVM chain id | **222222** (`0x3640e`) |
| EVM / substrate RPC (direct) | `https://node4.lark.hydration.cloud` · `wss://node4.lark.hydration.cloud` |
| Substrate RPC (subway, load-balanced) | `https://4.lark.hydration.cloud` · `wss://4.lark.hydration.cloud` |
| Relay RPC | `wss://relay4.lark.hydration.cloud` |
| Runtime `spec_version` | **441** |
| Deployer / owner | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |

> lark4 is a **fork of mainnet**, not a persistent testnet. A fork reset re-snapshots
> mainnet and **destroys every address below**. Re-read this file after any reset.

## Uniswap v3 core

| Contract | Address |
|---|---|
| UniswapV3Factory | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| SwapRouter02 | `0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0` |
| QuoterV2 | `0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e` |
| NonfungiblePositionManager | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` |
| TickLens | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| V3Migrator | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` |
| V3Staker | `0x610178dA211FEF7D417bC0e6FeD39F05609AD788` |
| Multicall2 | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| ProxyAdmin | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| NFTDescriptor library | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` |
| NonfungibleTokenPositionDescriptor | `0x0165878A594ca255338adfa4d48449f69242Eb8F` |
| Descriptor proxy | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` |
| WETH9 (gas token) | `0x0000000000000000000000000000000100000014` |

## Gamma ALM

| Contract | Address |
|---|---|
| HypervisorFactory | `0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf` |
| **Hypervisor (aDOT/HOLLAR)** | `0x7Ee5e4aCE3bdcEf233a5831d0494252AD6c7Cb21` |
| UniProxy | `0x36C02dA8a0983159322a80FFE9F24b1acfF8B570` |
| Clearing (ClearingV2) | `0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00` |
| Admin | `0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154` |
| Admin owner / advisor / keeper | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| RebalanceProxy | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` |

**Deposits go through `UniProxy`, not the Hypervisor directly** — ClearingV2 deposit
guards (price-vs-TWAP delta, per-address caps) are enforced there.

ALM config: `observationCardinality 2000`, `priceThreshold 10100`, `twapInterval 3600s`,
`maxTranslation 300`, `maxWidth 300`, `minInterval 600s`, posture `bootstrap`.

## Pools

### aDOT / HOLLAR 0.3% — the ALM pool (use this one)

| | |
|---|---|
| Pool | `0xc3139a43E80c1b5C0f31CFF9A60531B7cA3898ef` |
| token0 | `0x02639ec01313c8775Fae74F2dad1118c8A8a86dA` — aHydratedDOT, 10 dp |
| token1 | `0x531a654d1696ED52e7275A8cede955E82620f99a` — HOLLAR, 18 dp |
| fee | 3000 (0.3%) |
| tick / sqrtPriceX96 | 182854 · `740136925472034282735679603396051` |
| observationCardinalityNext | 2000 |
| feeProtocol | `[0, 0]` |

Seeded position: tokenId `2`, full range (`-887220`…`887220`), liquidity
`18683682720491696`, deposited ≈ 199.99 aDOT + 174.54 HOLLAR.

### DOT / HOLLAR 0.3% — smoke-test pool

| | |
|---|---|
| Pool | `0xa59A85D46d60286F2A8516bE3dd560E62d2a357D` |
| token0 | `0x0000000000000000000000000000000100000005` — DOT (asset 5), 10 dp |
| token1 | `0x00000000000000000000000000000001000000de` — HOLLAR (asset 222), 18 dp |
| fee | 3000 (0.3%) |
| observationCardinalityNext | 600 |

Built against asset-id alias addresses. The ALM pool above resolves its tokens
**through the asset registry** instead, which is why aDOT/HOLLAR uses real ERC20
addresses. Prefer the ALM pool for anything user-facing.

## Tokens

| Asset id | Address | Symbol | Decimals |
|---|---|---|---|
| 1001 | `0x02639ec01313c8775Fae74F2dad1118c8A8a86dA` | aHydratedDOT | 10 |
| — | `0x531a654d1696ED52e7275A8cede955E82620f99a` | HOLLAR (GhoToken) | 18 |
| 222 | `0x00000000000000000000000000000001000000de` | HOLLAR (asset alias) | 18 |
| 5 | `0x0000000000000000000000000000000100000005` | DOT | 10 |
| 20 | `0x0000000000000000000000000000000100000014` | WETH (gas) | 18 |

## Native router wiring

The runtime's Uniswap v3 venue is registered and **verified live on-chain** — the
native route executor will quote and route through these:

| `parameters` storage key | Value |
|---|---|
| `uniswapV3Factory` | `0x5fbdb2315678afecb367f032d93f642f64180aa3` |
| `uniswapV3SwapRouter` | `0xa51c1fc2f0d1a1b8494ed1fe312d7c3a78ed91c0` |
| `uniswapV3Quoter` | `0xb7f8bc63bbcad18155201308c8f3540b07f84f5e` |

Executor: `runtime/hydradx/src/evm/uniswap_v3_trade_executor.rs` in `hydration-node`.

## ABIs

Standard Uniswap v3 ABIs (`@uniswap/v3-core`, `@uniswap/v3-periphery`,
`swap-router-contracts`) apply unchanged. Gamma ABIs are built from
`galacticcouncil/gamma-hypervisor` → `artifacts/contracts/`.

## Sources

- `uniswap-v3-deploy` → `mainnet/deployments/lark4.json`, `lark4-pools.json`,
  `lark4-positions.json` (gitignored locally — this file is the shareable copy)
- `gamma-hypervisor` → `lark/deployments/lark4.json`
