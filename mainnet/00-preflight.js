/**
 * 00-preflight.js — read-only checks before touching mainnet:
 *   EVM RPC + chain id, deployer address, ContractDeployer whitelist,
 *   WETH gas balance, registry-resolved asset addresses + pool token ordering,
 *   parameters.uniswapV3* storage (post PR #1477), DIA feed freshness,
 *   EMA-oracle tracking for the pair (see `checkOracleTracking` below).
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { env, requireEnv, readFeedE18, assetToEvmAddress, resolveAssetAddress, ABI } = require("./lib");

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

/**
 * Will the runtime actually record this pool's trades in the EMA oracle?
 *
 * A v3 swap reports to the oracle under the `uniswpv3` source, and that record is
 * what pallet-dca and route-executor's set_route read. But the oracle DISCARDS
 * entries for pairs it does not track and returns success while doing so — so an
 * untracked pair produces a pool that trades fine and can never be DCA'd or set as
 * a default route, with no error, event or log to explain it.
 *
 * A pair is tracked when BOTH assets are `isSufficient` in the registry (the
 * asset-registry rule ignores the source entirely), or when the pair was added
 * explicitly via `emaOracle.addOracle`. Checking here turns a silent, invisible
 * failure into a launch-day line item.
 */
async function checkOracleTracking(api) {
  const ids = [Number(env("TOKEN_A", "1001")), Number(env("TOKEN_B", "222"))];
  const entries = await Promise.all(ids.map((id) => api.query.assetRegistry.assets(id)));

  const sufficiency = entries.map((e, i) => {
    if (e.isNone) return { id: ids[i], sufficient: false, note: "not registered" };
    const u = e.unwrap();
    return { id: ids[i], sufficient: u.isSufficient.isTrue, note: u.symbol.toHuman() };
  });

  for (const a of sufficiency) {
    a.sufficient
      ? ok(`asset ${a.id} (${a.note}) isSufficient`)
      : warn(`asset ${a.id} (${a.note}) is NOT sufficient`);
  }

  if (sufficiency.every((a) => a.sufficient)) {
    return ok("pair is EMA-oracle tracked (both assets sufficient) — v3 trades will be recorded");
  }

  // Fall back to the explicit whitelist, which is keyed by (source, orderedPair).
  const [lo, hi] = [...ids].sort((x, y) => x - y);
  let listed = false;
  try {
    const list = await api.query.emaOracle.whitelistedAssets();
    listed = list.toJSON().some((e) => {
      const [src, pair] = e;
      const srcAscii = Buffer.from(String(src).replace(/^0x/, ""), "hex").toString("ascii");
      return srcAscii === "uniswpv3" && Number(pair[0]) === lo && Number(pair[1]) === hi;
    });
  } catch {
    /* older runtimes may not expose it; the warning below still applies */
  }

  listed
    ? ok(`pair explicitly whitelisted via emaOracle.addOracle(uniswpv3, (${lo}, ${hi}))`)
    : warn(
        `pair is NOT EMA-oracle tracked — v3 trades will be silently discarded, so DCA and ` +
          `set_route through this pool will keep failing. Fix: governance call ` +
          `emaOracle.addOracle("uniswpv3", (${lo}, ${hi})).`
      );
}

/**
 * Resolve both pool assets the way the RUNTIME does, and report the ordering
 * `03-create-pool.js` will assert against.
 *
 * The alias (`0x…01 ++ id`) answers `symbol()` and `decimals()` for an Erc20-kind
 * asset too — on mainnet the aDOT alias reports "aDOT", 10 decimals — so checking
 * it here would print a green tick for an address the pool is never built on. It
 * has to come from the registry: `Erc20` -> the registered contract, `Token` ->
 * the alias. Only the contract addresses decide token0/token1, and for the launch
 * pair the two schemes sort OPPOSITE ways (by alias HOLLAR first, by contract aDOT
 * first), so this is also the one place an operator can read the correct
 * EXPECT_TOKEN0/EXPECT_TOKEN1 before `03` aborts on them.
 */
async function checkAssetsAndOrdering(api, provider) {
  const ids = [Number(env("TOKEN_A", "1001")), Number(env("TOKEN_B", "222"))];
  const addrs = [];

  for (const [label, id] of [
    ["TOKEN_A", ids[0]],
    ["TOKEN_B", ids[1]],
  ]) {
    let addr;
    try {
      addr = await resolveAssetAddress(api, id);
    } catch (e) {
      warn(`${label} asset ${id}: ${e.message}`);
      return;
    }
    const alias = assetToEvmAddress(id);
    const viaContract = addr.toLowerCase() !== alias.toLowerCase();
    try {
      const erc = new ethers.Contract(addr, ABI.erc20, provider);
      const [sym, dec] = await Promise.all([erc.symbol(), erc.decimals()]);
      ok(`${label} asset ${id} -> ${addr} (${sym}, ${dec} decimals, ${viaContract ? "Erc20 contract" : "Token alias"})`);
    } catch {
      warn(`${label} asset ${id} -> ${addr}: not readable`);
      return;
    }
    if (viaContract) console.log(`      alias ${alias} is NOT this asset's address — do not use it`);
    addrs.push({ id, addr });
  }

  const [t0, t1] = [...addrs].sort((a, b) => (a.addr.toLowerCase() < b.addr.toLowerCase() ? -1 : 1));
  ok(`pool ordering: token0 = asset ${t0.id}, token1 = asset ${t1.id}`);

  const [e0, e1] = [env("EXPECT_TOKEN0"), env("EXPECT_TOKEN1")];
  if (!e0 || !e1) {
    return warn(`EXPECT_TOKEN0/EXPECT_TOKEN1 unset — set EXPECT_TOKEN0=${t0.id} EXPECT_TOKEN1=${t1.id}`);
  }
  Number(e0) === t0.id && Number(e1) === t1.id
    ? ok(`EXPECT_TOKEN0/EXPECT_TOKEN1 match the chain`)
    : warn(
        `EXPECT_TOKEN0=${e0} EXPECT_TOKEN1=${e1} contradicts the chain — 03-create-pool.js will abort. ` +
          `Correct values: EXPECT_TOKEN0=${t0.id} EXPECT_TOKEN1=${t1.id}`
      );
}

async function main() {
  const evmRpc = env("EVM_RPC_URL", "https://rpc.hydradx.cloud");
  const wsUrl = env("WS_URL", "wss://rpc.hydradx.cloud");
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);

  console.log(`=== Preflight (${env("NET", "mainnet")}) ===`);
  const net = await provider.getNetwork();
  ok(`EVM RPC ${evmRpc} — chainId ${net.chainId}, block ${await provider.getBlockNumber()}`);
  console.log(`  deployer ${wallet.address}`);

  const gas = await provider.getBalance(wallet.address);
  gas > 0n
    ? ok(`WETH gas balance ${ethers.formatEther(gas)}`)
    : warn(`WETH gas balance is 0 — fund asset 20 before deploying`);

  // Asset addresses are resolved further down, once the substrate API is up:
  // an Erc20-kind asset lives at its registered contract, not at the alias, and
  // only the registry knows which kind it is.

  // Price feeds are Chainlink AggregatorV3, one contract per pair. DIA supplies
  // the data but does NOT serve it: every Hydration feed reverts on
  // getValue(string) and answers latestRoundData().
  const stale = Number(env("STALE_SECONDS", "3600"));
  for (const [label, key] of [
    ["PRICE_FEED_A", "PRICE_FEED_A"],
    ["PRICE_FEED_B", "PRICE_FEED_B"],
  ]) {
    const address = env(key);
    if (!address) {
      key === "PRICE_FEED_A"
        ? warn(`${label} not set — 03-create-pool.js will need PRICE`)
        : ok(`${label} not set — TOKEN_B assumed 1 USD`);
      continue;
    }
    try {
      const desc = await new ethers.Contract(address, ABI.aggregatorV3, provider).description();
      const r = await readFeedE18(ethers, address, provider, stale);
      ok(`${label} ${address} "${desc}" = ${(Number(r.priceE18) / 1e18).toFixed(6)} USD (age ${r.age}s)`);
    } catch (e) {
      warn(`${label} ${address} unreadable: ${e.message}`);
    }
  }

  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
  try {
    ok(`substrate WS ${wsUrl} — ${await api.rpc.system.chain()}`);
    const whitelisted = (await api.query.evmAccounts.contractDeployer(wallet.address)).isSome;
    whitelisted
      ? ok("deployer whitelisted in EVMAccounts::ContractDeployer")
      : warn("deployer NOT whitelisted — run 01-governance-calldata.js whitelist");

    if (api.query.parameters?.uniswapV3Factory) {
      const f = await api.query.parameters.uniswapV3Factory();
      f.isSome
        ? ok(`parameters.uniswapV3Factory = ${f.unwrap().toHex()}`)
        : warn("parameters.uniswapV3Factory unset — router venue not configured yet");
    } else {
      warn("runtime has no parameters.uniswapV3* storage — PR #1477 not live on this chain");
    }

    await checkAssetsAndOrdering(api, provider);
    await checkOracleTracking(api);
  } finally {
    await api.disconnect();
  }
  console.log("=== Preflight done ===");
}

main().catch((e) => {
  console.error("\n  Preflight FAILED:", e.message, "\n");
  process.exit(1);
});
