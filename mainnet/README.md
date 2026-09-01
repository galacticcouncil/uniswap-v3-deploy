# Hydration Uniswap v3 production handoff

This directory deploys the immutable Uniswap v3 contracts, creates the
aDOT/HOLLAR pool at an oracle-checked price, prepares its TWAP ring, and prints
the governance proposal that turns on the protocol fee and runtime integration.
It never submits governance transactions and it does not seed liquidity.

The mainnet flow is deliberately small:

| Phase | Command | Result |
| --- | --- | --- |
| Validate | `npm run preflight` | Read-only target/configuration gate |
| Deploy | `npm run deploy` | Full v3 contract stack and an address sheet |
| Pool | `npm run pool` | Creates, initializes and prepares the pool |
| Govern | `npm run governance -- launch` | Prints, but does not submit, the live-runtime proposal |
| Verify | `npm run verify` | Read-only post-enactment verification |

## Operator runbook

```bash
cd mainnet
npm ci
cp .env.example .env.mainnet
# Fill DEPLOYER_PK and review every value.

ENV_FILE=.env.mainnet npm run all
```

`npm run all` stops after printing the governance proposal. Submit the exact
preimage through OpenGov, wait for enactment, then run:

```bash
ENV_FILE=.env.mainnet npm run verify
# Optional: inspect every enactment block for hidden EVM failures.
ENV_FILE=.env.mainnet npm run verify -- events <first-enactment-block> <count>
```

The verifier checks contract code, ownership, the registry-resolved pool tokens,
initialization, protocol fee, TWAP capacity, EMA tracking, router registration
when supported by the runtime, and governance-event failure markers.

## Launch boundaries

- On 2026-09-01, Hydration mainnet runtime spec 440 does not expose
  `parameters.setUniswapV3Addresses`. The launch proposal therefore contains
  the protocol-fee call only. The standalone v3 stack and pool can launch now,
  but native router-venue registration remains a runtime-upgrade dependency;
  after that upgrade, run `npm run governance -- router` and verify again.
- The deployer needs WETH for EVM gas. It does not need to be in
  `EVMAccounts::ContractDeployer`: that list gates the RPC simulation route,
  not a signed CREATE. The launch scripts send fixed-gas transactions and never
  call `eth_estimateGas` for creation.
- `OWNER_ADDRESS` must be a governance-controlled EVM identity. On mainnet the
  script refuses to leave the factory or ProxyAdmin with the deployer.
- aDOT and HOLLAR must be resolved from the asset registry. Their asset-ID
  aliases are not the ERC-20 contract addresses the runtime routes through.
- A larger observation ring reserves storage; it does not create history. Wait
  for genuine trading history before the separate Gamma/ClearingV2 seed, or use
  its documented bootstrap procedure.

Generated address/state files are intentionally ignored by Git. Preserve the
generated `deployments/<net>.json`, `deployments/<net>-pool.json`, the reviewed
configuration with the private key removed, the proposal preimage, referendum
index, enactment block range, and final verifier output in the launch record.

---

# Handoff

Status as of **2026-09-01**: this flow was rehearsed end to end against a
**chopsticks fork of mainnet** (runtime spec 440) and finished green. Nothing
has been deployed to mainnet itself.

What the rehearsal covered, in one run:

| Phase | Result |
| --- | --- |
| `preflight` | passed — assets, registry-resolved addresses, token order, EMA tracking, feed freshness, ring sizing, owner |
| `deploy` | 15/15 steps, each confirmed on chain before being reported |
| `pool` | created and initialized at the feed price, ring grown to 2000/2000 |
| `governance -- launch` | printed the `setFeeProtocol(4,4)` proposal; nothing submitted |
| *(proposal enacted on the fork with Root)* | `evm.Executed`, `scheduler.Dispatched Ok`, preimage hash matched the printed one |
| `verify` | exit 0, all checks green including `protocol fee 4/4` |

Before enactment the verifier failed with `✗ protocol fee 0/0; expected 4/4`
and exit 1, so it discriminates rather than rubber-stamps.

## Decisions already made — do not re-open

| Item | Value | Source |
| --- | --- | --- |
| Pair | aDOT (1001) / HOLLAR (222) | `note-univ3-gamma-adot-hollar` |
| Fee tier | 3000 (0.30%) | ALM spec §A |
| Protocol fee | `setFeeProtocol(4, 4)` = 25%, on at launch | economics study P6, decided 2026-08-24 |
| `token0` | **aDOT** — contract sort inverts the asset-ID sort | verified against the registry |
| Factory + ProxyAdmin owner | `0xaa7e…aa7e0` (dispatcher Aave-manager) | economics study P5 |
| Observation cardinality | 2000 (floor is 1801 at 2s blocks) | — |
| `STALE_SECONDS` | 28800 | DIA age measured median 55 min, p90 3.6 h, max 7.4 h |
| Price feed | `0xFBCa0A6dC5B74C042DF23025D99ef0F1fcAC6702` | equals `AaveOracle.getSourceOfAsset(DOT)`, reads "DOT/USD Oracle" |

One item is still worth confirming with Ben: ALM spec §H **D2** still reads
"1/10 at launch", while the economics study P6 and the analysis note both say
4/4. We ship **4/4**; the D2 row was simply never updated.

## Run it

```bash
cd mainnet
npm ci
cp .env.example .env.mainnet     # fill DEPLOYER_PK, review every value
ENV_FILE=.env.mainnet npm run all
```

`npm run all` stops after printing the governance proposal. Submit that exact
preimage on **track 9 (`economic_parameters`)**, and after enactment:

```bash
ENV_FILE=.env.mainnet npm run verify
ENV_FILE=.env.mainnet npm run verify -- events <first-enactment-block> <count>
```

The `events` scan exists because `dispatcher.dispatchAsAaveManager` returns
`{Ok}` at the outer level even when the inner `evm.call` reverted, and
`utility.BatchCompleted` fires regardless — that combination bricked
money-market referendum 322. Treat a clean extrinsic result as meaningless;
only the event scan and the state verifier are evidence.

## Things that will bite

- **Always pass `ENV_FILE`.** With it unset, `lib.js` falls back to
  `mainnet/.env`. There is no such file now, and there should not be one —
  a stray `.env` would silently redirect a mainnet command at another chain.
- **The deploy key must be an unbound EVM address.** If it has an
  `EVMAccounts::AccountExtension` entry, the runtime resolves it through
  `bound_account_id`, not the `ETH\0`-truncated account, and funding the
  truncated account has no effect. A freshly generated key is unbound.
- **Contract addresses depend on the deploy key's nonce sequence.** They are
  *not* portable from lark4 or from any rehearsal. Nothing downstream — SDK, UI,
  router registration — may carry a pre-existing `swapRouter02` or `quoterV2`.
- **Resume state is chain-specific.** `deployments/<net>-state.json` records
  addresses only; `02-deploy.js` refuses to resume when any recorded address has
  no code on the target chain. Do not delete that file to "get past" the error.
- **Gas is fixed, not estimated.** Transactions use legacy `gasPrice =
  eth_gasPrice × GAS_PRICE_MULT` and a fixed `EVM_GAS_LIMIT`, because
  Hydration's `eth_estimateGas` under-reports and an under-priced transaction is
  dropped at apply *without producing a receipt*. Growing the ring costs
  ~42,456 gas per slot, so `OBS_CHUNK × 42456` must fit inside `EVM_GAS_LIMIT`.
- **`system.dryRun` is not trustworthy here.** It reported
  `InvalidTransaction::Payment` for transactions that then executed with
  `status 1`. Judge by receipts and state, never by a dry run.

## Deliberately out of scope

- **Liquidity.** The pool launches live and empty. Seeding goes through the
  Gamma UniProxy in `gamma-hypervisor` so the ClearingV2 guards apply.
- **Router registration.** Mainnet spec 440 has no
  `parameters.setUniswapV3Addresses` (PR #1477 is unmerged), so nothing routes
  to the pool yet and the launch proposal omits it. After that runtime ships,
  run `npm run governance -- router` and verify again.
- **TWAP history.** The ring reserves 2000 slots but fills one per block that
  *trades*. `observe(3600)` reverts until the pool has an hour of real trading,
  so the first Gamma seed deposit will fail before then.

## Hand back after launch

Archive, with `DEPLOYER_PK` removed: the reviewed config, both generated
`deployments/<net>.json` and `<net>-pool.json`, the proposal preimage and hash,
the referendum index, the enactment block range, and the passing `verify` and
`verify -- events` output.
