# Hydration Uniswap v3 production handoff

This directory deploys the immutable Uniswap v3 contracts, creates the
aDOT/HOLLAR pool at an oracle-checked price, prepares its TWAP ring, and prints
the governance proposals that authorize the deployer and turn on the protocol
fee and the runtime router. It never submits governance transactions and it does
not seed liquidity.

The mainnet flow is deliberately small:

| Phase | Command | Result |
| --- | --- | --- |
| Authorize | `npm run governance -- deployer` | Prints the Root proposal listing the deploy key. **Must be enacted before deploying.** |
| Validate | `npm run preflight` | Read-only target/configuration gate |
| Deploy | `npm run deploy` | Full v3 contract stack and an address sheet |
| Pool | `npm run pool` | Creates, initializes and prepares the pool |
| Govern | `npm run governance -- launch` | Prints, but does not submit, the live-runtime proposal |
| Verify | `npm run verify` | Read-only post-enactment verification |

There are **two** referenda, and their order is load-bearing. The first lists
the deploy key and must enact before any contract is deployed. The second
carries the protocol fee and the router registration, and can only be built
after the contracts exist, because it contains their addresses.

## Operator runbook

```bash
cd mainnet
npm ci
cp .env.example .env.mainnet
# Fill DEPLOYER_PK and review every value.

# 1. Authorize the deploy key, then submit and wait for enactment.
ENV_FILE=.env.mainnet npm run governance -- deployer

# 2. Once that referendum has enacted:
ENV_FILE=.env.mainnet npm run all
```

`npm run all` stops after printing the launch proposal. Submit the exact
preimage through OpenGov, wait for enactment, then run:

```bash
ENV_FILE=.env.mainnet npm run verify
# Optional: inspect every enactment block for hidden EVM failures.
ENV_FILE=.env.mainnet npm run verify -- events <first-enactment-block> <count>
```

The verifier checks contract code, ownership, the registry-resolved pool tokens,
initialization, protocol fee, TWAP capacity, EMA tracking, all three router
addresses, and governance-event failure markers.

## Launch boundaries

- **Both proposals go on track 0 (Root).** This is not caution:
  `pallet_parameters::set_uniswap_v3_addresses` is `ensure_root(origin)` with no
  configurable origin type, so router registration cannot be an
  EconomicParameters referendum. The protocol-fee and EMA calls individually do
  accept the narrower track; bundling them under Root costs no extra privilege
  and saves a second decision deposit and enactment window. The Root-equivalent
  fast path is a Technical Committee whitelist of the preimage hash followed by
  a track-1 (`whitelisted_caller`) referendum. The TC is not itself an origin
  that can make these calls.
- **The deploy key must be on `EVMAccounts::ContractDeployer` before deploying.**
  From runtime spec 443 `pallet_evm`'s `CreateOriginFilter` is
  `EnsureWhitelistedDeployer`, so an unlisted key's *signed* CREATE fails with
  `evm.CreateOriginNotAllowed`. On spec 440 and earlier the filter was `()` and
  the list only gated the RPC simulation route. Listing it is
  `evmAccounts.addContractDeployer`, whose ControllerOrigin is Root or the
  GeneralAdmin track. An enactment landing mid-run strands the deploy:
  `02-deploy.js` will not resume once a recorded address has no code, and CREATE
  addresses are nonce-derived.
- `OWNER_ADDRESS` must be a governance-controlled EVM identity. On mainnet the
  script refuses to leave the factory or ProxyAdmin with the deployer.
- aDOT and HOLLAR must be resolved from the asset registry. Their asset-ID
  aliases are not the ERC-20 contract addresses the runtime routes through.
- A larger observation ring reserves storage; it does not create history. Wait
  for genuine trading history before the separate Gamma/ClearingV2 seed, or use
  its documented bootstrap procedure.

Generated address/state files are intentionally ignored by Git. Preserve the
generated `deployments/<net>.json`, `deployments/<net>-pool.json`, the reviewed
configuration with the private key removed, both proposal preimages, referendum
indices, enactment block ranges, and final verifier output in the launch record.

---

# Handoff

Status as of **2026-09-07**: this flow was rehearsed end to end against a
**chopsticks fork of mainnet running runtime spec 443** — the wasm built from
`galacticcouncil/hydration-node` `origin/master` at `d1519bdc5`, which is the
first runtime that carries both the Uniswap v3 router and the contract-deployer
create filter. It finished green. Nothing has been deployed to mainnet itself.

Mainnet is still on spec 440 at the time of writing. **This flow targets 443 and
should be run after that runtime ships**, because the launch bundle registers the
router and 440 has no `parameters.setUniswapV3Addresses`.

What the rehearsal covered, in one run:

| Phase | Result |
| --- | --- |
| unlisted CREATE probe | failed with `evm.CreateOriginNotAllowed` (module 90, error 13) — the filter is live |
| `preflight` (before authorization) | correctly failed: deployer not in `EVMAccounts::ContractDeployer` |
| referendum 1 — `governance -- deployer` | `evmAccounts.addContractDeployer`, 22 bytes, inline; enacted `Dispatched Ok` |
| `preflight` (after) | passed — assets, registry-resolved addresses, token order, EMA tracking, feed freshness, ring sizing, owner |
| `deploy` | 15/15 steps, each confirmed on chain before being reported |
| `pool` | created and initialized at the feed price (0.977483), ring grown to 2000 |
| `verify` (before enactment) | correctly failed with 4 checks: protocol fee `0/0`, and all three router slots unset |
| referendum 2 — `governance -- launch` | `utility.batchAll`, 255 bytes, preimage `0x4f81d0be…`, track 0 |
| *(enacted on the fork with Root)* | `scheduler.Dispatched Ok`, no `evm.ExecutedFailed`, preimage hash matched the printed one |
| `verify` (after) | exit 0, all checks green including `protocol fee 4/4` and all three router addresses |

The verifier discriminates rather than rubber-stamps: it failed 4 checks before
enactment and passed all of them after, with no change to the script.

**What the rehearsal does not prove.** Router registration is verified at the
storage level — the three addresses in `pallet_parameters` match the deployment
record. It does not exercise a trade through `UniswapV3TradeExecutor`, because
the launch pool is empty and a quote against zero liquidity is inconclusive
either way. End-to-end executor coverage lives in
`integration-tests/src/uniswap_v3_router.rs` on hydration-node master.

## Decisions already made — do not re-open

| Item | Value | Source |
| --- | --- | --- |
| Pair | aDOT (1001) / HOLLAR (222) | `note-univ3-gamma-adot-hollar` |
| Fee tier | 3000 (0.30%) | ALM spec §A |
| Protocol fee | `setFeeProtocol(4, 4)` = 25%, on at launch | economics study P6, decided 2026-08-24 |
| Governance track | 0 (Root), both referenda | `set_uniswap_v3_addresses` is `ensure_root` |
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

ENV_FILE=.env.mainnet npm run governance -- deployer   # referendum 1, track 0
# ... wait for enactment ...
ENV_FILE=.env.mainnet npm run all                      # prints referendum 2
# ... wait for enactment ...
ENV_FILE=.env.mainnet npm run verify
ENV_FILE=.env.mainnet npm run verify -- events <first-enactment-block> <count>
```

The `events` scan exists because `dispatcher.dispatchAsAaveManager` returns
`{Ok}` at the outer level even when the inner `evm.call` reverted, and
`utility.BatchCompleted` fires regardless — that combination bricked
money-market referendum 322. Treat a clean extrinsic result as meaningless;
only the event scan and the state verifier are evidence.

## Things that will bite

- **An unauthorized deploy hangs, it does not error.** A CREATE from an unlisted
  key fails as a *Substrate* extrinsic (`evm.CreateOriginNotAllowed`) and
  therefore produces **no EVM receipt at all** — a script waiting on the receipt
  waits forever. `00-preflight.js` is the only thing that catches this in
  advance. Do not skip it.
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
  This is also why the router addresses cannot be runtime constants.
- **A wrong router address is silent.** `getPool` against an address holding no
  code simply finds no pool, so the venue goes quiet instead of failing. The
  verifier checks all three registered addresses against the deployment record
  for exactly this reason; checking only the factory would not catch it.
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
- **TWAP history.** The ring reserves 2000 slots but fills one per block that
  *trades*. `observe(3600)` reverts until the pool has an hour of real trading,
  so the first Gamma seed deposit will fail before then.
- **Running on spec 440.** The scripts degrade gracefully — the launch bundle
  omits the router call and says so — but the result is a pool nothing routes
  to. Wait for 443.

## Hand back after launch

Archive, with `DEPLOYER_PK` removed: the reviewed config, both generated
`deployments/<net>.json` and `<net>-pool.json`, both proposal preimages and
hashes, both referendum indices, the enactment block ranges, and the passing
`verify` and `verify -- events` output.
