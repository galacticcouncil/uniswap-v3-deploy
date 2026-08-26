# Deployed addresses — aDOT/HOLLAR

> **lark4 testnet. Not mainnet.**
> Uniswap v3 is **not deployed on Hydration mainnet** — `parameters.uniswapV3*` storage is
> unset there, so the router venue is inert and there is nothing for a front end to point at.
> Everything below exists only on the lark4 fork.

**Rebuilt from scratch 2026-08-26.** The fork was reset to a fresh mainnet snapshot and the
whole stack redeployed, so every address below was re-derived — the v3 addresses are byte-for-byte
the same as the previous build (the deploy runs from deployer nonce 0, so CREATE is deterministic),
but **every Gamma address changed**. The pool address is unchanged too, since it is CREATE2 over
(token0, token1, fee) from the same factory.

Verified on-chain at lark4 block 730 — all 19 addresses below hold code and match the generated
artifacts; smoke test 14/14; and a **freshly generated keypair** — not a pre-funded one — deposited
through UniProxy and was minted shares, so the path is open to any account.

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
deposit against the configured TWAP window.

**5. But approve the Hypervisor, not UniProxy.**
This is the trap in the sentence above. You *call* `UniProxy.deposit(...)`, but UniProxy
forwards to `Hypervisor.deposit(…, from = msg.sender)` and it is the **Hypervisor** that runs
`transferFrom` against you. An allowance granted to UniProxy is never touched and the deposit
reverts. Approve with the `2^128-1` sentinel — the asset precompile reads a u128 `Balance`, so
`MaxUint256` overflows.

**6. Deposits are permissionless, but ratio-checked and range-checked.**
There is no depositor allowlist — `freeDepositList` only *relaxes* the ratio rule for an
address, it does not gate entry, and `maxTotalSupply` is `0` (uncapped). What will reject you:
supplying only one side, supplying a pair outside the band `UniProxy.getDepositAmount()`
returns, or depositing while the pool tick is outside the vault's base range. Read the required
pair amount from `getDepositAmount()` rather than computing it yourself.

---

## The pool

aDOT/HOLLAR, 0.3% tier. The observation ring is **sized** for a full hour (cardinality 2000),
but sizing is not history: the slots are reserved, and one is filled per block that trades. So
`observe(w)` still reverts with `OLD` for any `w` longer than the pool has actually been running,
however large the ring is. That is why `twapInterval` is only 30 s here — see the Gamma section.

| | Address |
| --- | --- |
| **Pool** (aDOT/HOLLAR 0.3%) | `0xc3139a43E80c1b5C0f31CFF9A60531B7cA3898ef` |
| **token0** — aDOT, asset 1001, 10 dec | `0x02639ec01313c8775Fae74F2dad1118c8A8a86dA` |
| **token1** — HOLLAR, asset 222, 18 dec | `0x531a654d1696ED52e7275A8cede955E82620f99a` |

| Param | Value |
| --- | --- |
| Fee tier | `3000` |
| Tick spacing | `60` |
| Initialised at | `0.900622` HOLLAR per aDOT |
| Current tick | `183168` |
| Observation cardinality | `2000 / 2000` |
| Liquidity | `18980229243982476` |
| Protocol fee | `4 / 4` — ON, 25% of swap fees (`slot0.feeProtocol = 68`) |

The init price was derived from **the fork's own Omnipool**, not the price feed:
`lrna_per(aDOT) / lrna_per(HOLLAR)` = `0.15102427 / 0.16768871` = `0.900622`. A fork has no
off-chain DIA pusher, so its feed is frozen at snapshot time and pricing the pool off it would
hand the first arber a free round trip against the Omnipool. The frozen feed was read anyway as
a cross-check and agreed to **49 bps**.

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
| **UniProxy** — deposit entry point | `0x851356ae760d987E095750cCeb3bC6014560891C` |
| **Hypervisor** — vault / LP token | `0xFa45C2f07Cf62C543F2247E9e5B5a6acBEc762ae` |
| ClearingV2 — deposit guards | `0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8` |
| HypervisorFactory | `0x9E545E3C0baAB3E08CdfD552C960A1050f373042` |
| Admin | `0x70e0bA845a1A0F2DA3359C97E0285013525FFC49` |
| RebalanceProxy | `0x4826533B4897376654Bb4d4AD88B7faFD0C98528` |

LP token is **`Gamma aHydratedDOT-HOLLAR` / `gaHydratedDOT-HOLLAR`**. The name and symbol are
ERC20 constructor args with no setter, so they are read off chain at deploy time rather than
written as literals — `aHydratedDOT` is asset 1001's actual on-chain symbol.

| Config | Value |
| --- | --- |
| `twapInterval` | **`30` s** — deliberately short, lark only |
| `priceThreshold` | `10100` |
| `maxTranslation` | `300` |
| `maxWidth` | `300` |
| `minInterval` | `600` s |
| Base range at handover | `[182520, 183780]` (width 1260) |
| Posture | `bootstrap` |

> **`twapInterval` is 30 s here, and that is a testnet-only setting.** ClearingV2 calls
> `observe()` on every deposit, and `observe(w)` reverts with `OLD` for any `w` longer than
> the pool has actually been running — so a long window locks deposits out of a fresh pool
> for that long. 30 s keeps lark4 immediately usable for anyone poking at it. It also makes
> the price-deviation guard nearly toothless, which is fine on a fork nobody profits from
> manipulating and **not** fine anywhere else: mainnet launches at 3600 s, matching
> `TWAP_WINDOW_SECS` in `mainnet/.env`. Raise it with `ClearingV2.setTwapInterval` (owner-only,
> no minimum enforced) once the pool has that much history.

---

## Caveats

- **Roles are testnet placeholders.** `adminOwner`, `advisor` and `keeper` are all the
  deployer EOA (`0xf39Fd6e5…`) on this fork. On mainnet the Admin owner is a governance
  address and the deploy hands it over as its last step.
- **lark4 is a fork and gets reset.** If a call starts returning the zero address, re-check
  the deployment before debugging the integration. The v3 addresses survive a rebuild (nonce-0
  CREATE), so "the factory answers but `getPool` is zero" means the pool was not recreated yet —
  not that you have the wrong address. **Gamma addresses do not survive**; re-read them.
- **Two things break a freshly reset fork**, both found on 2026-08-26:
  - A snapshot inherits mainnet's in-flight referenda. The Root track's `maxDeciding` is 3, and
    their alarms are mainnet block heights the fork will never reach, so if mainnet had 3 Root
    referenda deciding, *every* new Root referendum queues forever and `system.setCode` can
    never enact. Pick the snapshot block by `Referenda::DecidingCount(0) <= 2` — mainnet's RPC
    is an archive node, so it can be measured directly.
  - `node4_fork`'s memory cap was 15000M and it OOMed repeatedly. A *freshly bootstrapped* fork
    already used 9.2 GB of it. Raised to 32000M (`node3_fork`, the one that stays up, is 20000M).
- Source artifacts: `mainnet/deployments/lark4.json` and `lark4-pools.json` in this repo
  (gitignored — regenerate with `02-deploy.js` / `03-create-pool.js`), and
  `lark/deployments/lark4.json` in `gamma-hypervisor`.
