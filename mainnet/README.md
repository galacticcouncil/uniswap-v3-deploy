# Uniswap v3 launch scripts (mainnet / lark)

Production counterpart of `zombienet/`: gets the v3 stack from zero to a live,
oracle-priced, TWAP-ready pool on a real Hydration network. **Production**
liquidity seeding is not here — that goes through the Gamma UniProxy
(`gamma-hypervisor` repo), so the ClearingV2 deposit guards apply. `06`/`07`
exist only so a testnet pool has depth to smoke-test against.

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
| 3 | `node 02-deploy.js` | runs the repo CLI (~14 txs) **and hands factory + ProxyAdmin to `OWNER_ADDRESS`**, writes `deployments/<net>.json` |
| 4 | `node 03-create-pool.js` | assert token ordering, create + `initialize` at DIA price, grow observation cardinality |
| 5 | *(gamma-hypervisor)* | Hypervisor + UniProxy/ClearingV2, vault seeding |
| 6 | `node 01-governance-calldata.js set-addresses` | `parameters.setUniswapV3Addresses` calldata → Root referendum (needs PR [#1477](https://github.com/galacticcouncil/hydration-node/pull/1477) runtime) |
| 7 | `node 04-owner-ops.js transfer-owner <governance-evm>` | **only if step 3 ran without `OWNER_ADDRESS`** — otherwise verify `factory.owner()` and move on |
| 8 | `node 04-owner-ops.js set-fee-protocol <pool> 4 4` | **protocol fee ON at launch, at the contract maximum** — see below |
| 9 | `node 04-owner-ops.js collect-protocol <pool> <recipient>` | sweep accrued protocol fees (repeat as needed) |

On **lark** the governance calls can instead be auto-submitted by
`hydration-node/scripts/uniswap-v3-lark` (fast-track root referenda); these
scripts still work there with `NET=lark` and the lark RPC urls.

### Who owns the factory

`UniswapV3Factory.owner` is an EVM address, so governance cannot merely
*authorise* an owner call — it has to **be** that address. Hydration's
`EnsureAddressTruncated` lets a Substrate account call `evm.call` with
`source = A` when the account's **first 20 bytes are A**. There is no arbitrary
Root source. The governance dispatch accounts are chosen with that in mind:

| EVM address | reached by | origin |
| --- | --- | --- |
| `0xaa7e0000000000000000000000000000000aa7e0` | `dispatcher.dispatchAsAaveManager` | Root **or** EconomicParameters |
| `0x6d6f646c70792f74727372790000000000000000` | `dispatcher.dispatchAsTreasury` | Root **or** Treasurer |

We use the first: it is already the Aave market's `ACLManager` admin, and its
track — economic parameters — is exactly what `setFeeProtocol` /
`enableFeeAmount` are.

Set `OWNER_ADDRESS` **before** step 3. The deploy CLI enables the 1bp tier at
step 2 of its own run and only transfers ownership at steps 11 and 15, so a
governance owner does not break the tier-enable. `02-deploy.js` refuses to run
on `NET=mainnet` with the deployer as owner (override: `ALLOW_DEPLOYER_OWNER=true`,
testnets only).

Owner calls then look like this — `04-owner-ops.js` prints the `{to, data}`:

```
dispatcher.dispatchAsAaveManager(
  evm.call {
    source: 0xaa7e0000000000000000000000000000000aa7e0,
    target: <pool or factory>,
    input:  <data from 04-owner-ops.js>,
    ...
  }
)
```

> **A wrong owner does not revert your referendum.** The dispatcher returns
> `{Ok}` while the inner `evm.call` fails, `utility.BatchCompleted` fires, and
> every surface signal looks clean. This is how money-market referendum 322
> bricked (recovery took refs 323 and 324) — see
> `money-market/HDCL-MAINNET-HANDOVER.md`. Always check the **full** event log
> for `evm.ExecutedFailed`, not just the tail, and confirm `factory.owner()`
> on-chain after step 3.

### Protocol fee: ON at launch, `4 4`

`setFeeProtocol` takes a **denominator**, so a *bigger* number is a *smaller*
fee. Allowed values are `0` (off) or `4`–`10`; `4` = 1/4 = 25% of the swap fee
and is the contract maximum, `10` = 1/10 = 10% is the minimum non-zero.

| value | protocol take of the swap fee |
| --- | --- |
| `0` | nothing |
| `10` | 10% (minimum non-zero) |
| **`4`** | **25% — the maximum, and what we launch with** |

The fee being on from launch is a decision, not a default: the protocol takes a
real fee on every other venue (Omnipool's take is far higher), and retro-fitting
one after LPs have priced in zero is a worse conversation than starting with it.
Launching at the **maximum** rather than 1/10 is a deliberate override of the
earlier `D2` leaning in the garden ALM spec — that note models a 1/4 skim as
larger than the vault's gross net margin at arb-only flow, so **watch net markout
in week 1 and be ready to step down to `10 10`** if organic share stays near zero.

Ordering note: once the factory is governance-owned (step 7, or `OWNER_ADDRESS`
set at step 3), `04-owner-ops.js` stops sending and prints `{to, data}` instead —
so steps 8 and 9 are governance `evm.call`s and can ride in the same referendum
bundle as step 6. Run step 8 **after** the pool exists (step 4); `setFeeProtocol`
is per-pool, not per-factory.

## Testnet-only extras (lark forks)

`05` refuses to run unless `Parameters::IsTestnet` is true. Together these take a
fresh lark fork all the way to a traded pool without leaving this directory:

| # | Command | What |
| --- | --- | --- |
| 5a | `node 05-testnet-govern.js` | one Root referendum (via `//Alice`): whitelist the deployer for CREATE **and** fund it with gas + both pool assets |
| 6a | `node 06-seed-position.js [lo hi]` | mint an NPM position (full range by default) so the pool has depth |
| 7a | `node 07-smoke-test.js` | quote → swap → reverse swap → pool invariants; exits non-zero on any failed check |

### Why 05 is not just `currencies.updateBalance`

Funding is **asset-kind aware**, and that is the whole point of the script:

| kind | example | how it gets funded |
| --- | --- | --- |
| `Token` | WETH 20, DOT 5 | `currencies.updateBalance` — Root mints directly |
| `Erc20` | HOLLAR 222, aDOT 1001 | `dispatcher.dispatchAsTreasury(currencies.transfer(…))` |

Root **cannot mint an `Erc20`-registered asset**: `pallet-currencies` fails with
`NotSupported` when `BoundErc20::contract_address(id)` is `Some`, because the
balance lives in an EVM contract rather than in pallet-tokens. So the script
moves existing supply out of the treasury instead. Any script that assumes
`updateBalance` works for every asset will silently fail the moment the pair
includes HOLLAR or an aToken.

### lark gotchas baked into 06/07

- **Approvals use the `2^128-1` sentinel.** The asset precompile's
  `approve(address,uint256)` reads a u128 `Balance`, so `MaxUint256` overflows it.
- **Explicit `gasLimit`** (`EVM_GAS_LIMIT`, default 10M) — lark's `estimateGas`
  under-shoots mint/CREATE.
- **`CONFIRMATIONS=3`** — lark's stale-pending otherwise shows up as "nonce too low".
- **No DIA on a fork.** A lark fork has no off-chain price pusher, so its DIA feed
  is frozen at snapshot time and `03` would abort as stale. Set `PRICE` from the
  fork's own Omnipool instead (`lrna_per(aDOT) / lrna_per(HOLLAR)`), which is the
  price an arber on that chain would trade against.

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
| **aDOT** (launch pair) | **1001** | `0x00000000000000000000000000000001000003e9` |
| HOLLAR | 222 | `0x00000000000000000000000000000001000000de` |
| DOT (test pools only) | 5 | `0x0000000000000000000000000000000100000005` |

Decimals differ (aDOT 10, HOLLAR 18) — the price math in `lib.js` is
decimals-aware; `PRICE`/DIA values are always human units (HOLLAR per aDOT).
aDOT is 1:1 with DOT (the balance rebases, the price does not), so the DIA
DOT/USD feed *is* the aDOT price — no index factor.

### Token ordering flips between the test pair and the launch pair

A v3 pool has no "pair". It has `token0` and `token1`, assigned by sorting the
two raw addresses. On Hydration the address is the asset id sitting in its last
4 bytes, so that sort is just an **id sort**:

| pair | ids | token0 | token1 |
| --- | --- | --- | --- |
| DOT / HOLLAR (test) | 5, 222 | DOT | HOLLAR |
| **aDOT / HOLLAR (launch)** | 1001, 222 | **HOLLAR** | **aDOT** |

Every tick sign inverts with it, and nothing reverts to tell you — aDOT and DOT
are both 10 decimals, so a DOT pool looks right until the Hypervisor points at
it. Any tick-sign assumption validated against a DOT test pool is backwards on
the launch pool.

`03-create-pool.js` sorts dynamically (correct) **and** asserts the result
against `EXPECT_TOKEN0` / `EXPECT_TOKEN1` — asset ids, in pool order. Set both
on mainnet; the script warns loudly if they are unset.

## Notes

- Gas is paid in WETH (asset 20); `eth_getBalance` == WETH balance.
- The router's `WETH9` is the asset-20 precompile. It does **not** implement
  `deposit`/`withdraw`, so native-value paths (`unwrapWETH9`, `refundETH`,
  msg.value multicalls) must never be used by integrations.
- `04-owner-ops.js` sends directly while the deploy key still owns the factory,
  and prints raw `{to, data}` for governance `evm.call` wrapping after handoff.
