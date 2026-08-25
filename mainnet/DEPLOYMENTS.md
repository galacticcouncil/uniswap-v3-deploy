# Deployed addresses — aDOT/HOLLAR

> **lark4 testnet. Not mainnet.**
> Uniswap v3 is **not deployed on Hydration mainnet** — `parameters.uniswapV3*` storage is
> unset there, so the router venue is inert and there is nothing for a front end to point at.
> Everything below exists only on the lark4 fork.

Verified on-chain at lark4 block 403,757 — all contracts hold code.

| | |
| --- | --- |
| EVM RPC | `https://node4.lark.hydration.cloud` |
| Substrate WS | `wss://node4.lark.hydration.cloud` |
| Chain ID | `222222` |

---

## Read this before wiring anything up

**1. Do not derive token addresses from asset ids.**
aDOT (1001) and HOLLAR (222) are `Erc20`-kind assets, so they live at a **registered contract**,
not at the `0x…01 ++ id` alias. The alias is a live precompile that answers `symbol()` and
`decimals()` — it looks like the token — but `getPool` against it returns the zero address:

```
alias    token0 0x…01000000de  token1 0x…01000003e9
  -> getPool = 0x0000000000000000000000000000000000000000
contract token0 0x02639ec0…    token1 0x531a654d…
  -> getPool = 0xc3139a43E80c1b5C0f31CFF9A60531B7cA3898ef
```

Resolve through the asset registry's `AccountKey20` location, the way the runtime does
(`HydraErc20Mapping::asset_address`). This already cost us a silent bug in the SDK.

**2. token0 is aDOT, not HOLLAR.**
v3 sorts by raw address, and the contract sort inverts the id sort: `222 < 1001` would put
HOLLAR first, but `0x0263… < 0x531a…` puts aDOT first. Every tick sign follows from this.

**3. WETH9 has no `deposit` / `withdraw`.**
The router's WETH9 is the asset-20 gas precompile. Native-value paths — `unwrapWETH9`,
`refundETH`, `msg.value` multicalls — must never be used.

**4. Vault deposits go through UniProxy, never the Hypervisor directly.**
UniProxy is what applies the ClearingV2 guards, and ClearingV2 calls `observe()` on every
deposit against a 3600 s TWAP window.

---

## The pool

aDOT/HOLLAR, 0.3% tier. The observation ring is fully grown, so `observe()` over the full
hour works.

| | Address |
| --- | --- |
| **Pool** (aDOT/HOLLAR 0.3%) | `0xc3139a43E80c1b5C0f31CFF9A60531B7cA3898ef` |
| **token0** — aDOT, asset 1001, 10 dec | `0x02639ec01313c8775Fae74F2dad1118c8A8a86dA` |
| **token1** — HOLLAR, asset 222, 18 dec | `0x531a654d1696ED52e7275A8cede955E82620f99a` |

| Param | Value |
| --- | --- |
| Fee tier | `3000` |
| Tick spacing | `60` |
| Current tick | `182854` |
| Observation cardinality | `2000 / 2000` |
| Liquidity | `18683682720491696` |
| Protocol fee | `0` (off on the fork; launches at `4 4`) |

---

## Uniswap v3 core

| Contract | Address |
| --- | --- |
| UniswapV3Factory | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| SwapRouter02 | `0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0` |
| QuoterV2 | `0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e` |
| NonfungiblePositionManager | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` |
| TickLens | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| Multicall2 | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| V3Migrator | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` |
| V3Staker | `0x610178dA211FEF7D417bC0e6FeD39F05609AD788` |
| ProxyAdmin | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| WETH9 (asset 20, gas) | `0x0000000000000000000000000000000100000014` |

---

## Gamma vault stack

`UniProxy` and `Hypervisor` are the two a front end touches. The rest are keeper and
governance surfaces, listed so nothing gets guessed at.

| Contract | Address |
| --- | --- |
| **UniProxy** — deposit entry point | `0x36C02dA8a0983159322a80FFE9F24b1acfF8B570` |
| **Hypervisor** — vault / LP token | `0x7Ee5e4aCE3bdcEf233a5831d0494252AD6c7Cb21` |
| ClearingV2 — deposit guards | `0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00` |
| HypervisorFactory | `0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf` |
| Admin | `0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154` |
| RebalanceProxy | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` |

| Config | Value |
| --- | --- |
| `twapInterval` | `3600` s |
| `priceThreshold` | `10100` |
| `maxTranslation` | `300` |
| `maxWidth` | `300` |
| `minInterval` | `600` s |
| Posture | `bootstrap` |

---

## Caveats

- **Roles are testnet placeholders.** `adminOwner`, `advisor` and `keeper` are all the
  deployer EOA (`0xf39Fd6e5…`) on this fork. On mainnet the Admin owner is a governance
  address and the deploy hands it over as its last step.
- **lark4 is a fork and gets reset.** If a call starts returning the zero address, re-check
  the deployment before debugging the integration.
- Source artifacts: `mainnet/deployments/lark4.json` and `lark4-pools.json` in this repo
  (gitignored — regenerate with `02-deploy.js` / `03-create-pool.js`), and
  `lark/deployments/lark4.json` in `gamma-hypervisor`.
