/**
 * Read-only post-enactment verifier.
 *
 *   node 04-verify.js
 *   node 04-verify.js events <first-block> [count]
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const {
  env,
  loadDeployments,
  resolveAssetAddress,
  sortTokens,
  readFeedE18,
  priceE18FromSqrtPriceX96,
  fmtE18,
  ABI,
} = require("./lib");

const EMA_SOURCE = "0x756e697377707633";
let failures = 0;
const pass = (message) => console.log(`  ✓ ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`  ✗ ${message}`);
};
const note = (message) => console.log(`  ! ${message}`);

const equalAddress = (label, actual, expected) => {
  actual.toLowerCase() === expected.toLowerCase()
    ? pass(`${label} = ${actual}`)
    : fail(`${label} = ${actual}; expected ${expected}`);
};

async function emaTracked(api, ids) {
  const registry = await Promise.all(ids.map((id) => api.query.assetRegistry.assets(id)));
  if (registry.every((asset) => asset.isSome && asset.unwrap().isSufficient.isTrue)) return true;
  const list = await api.query.emaOracle.whitelistedAssets();
  const [a, b] = [...ids].sort((x, y) => x - y);
  return list.toJSON().some(([source, pair]) =>
    String(source).toLowerCase() === EMA_SOURCE && Number(pair[0]) === a && Number(pair[1]) === b
  );
}

async function scanEvents(api, first, count) {
  if (!Number.isInteger(first) || !Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("usage: node 04-verify.js events <first-block> [count 1..100]");
  }
  console.log(`=== Scanning blocks ${first}..${first + count - 1} ===`);
  let markers = 0;
  for (let height = first; height < first + count; height += 1) {
    const hash = await api.rpc.chain.getBlockHash(height);
    const events = await (await api.at(hash)).query.system.events();
    for (const { event } of events) {
      const key = `${event.section}.${event.method}`;
      if (["evm.ExecutedFailed", "utility.BatchInterrupted", "system.ExtrinsicFailed"].includes(key)) {
        markers += 1;
        console.log(`  ✗ #${height} ${key}: ${JSON.stringify(event.data.toHuman())}`);
      }
    }
  }
  markers ? fail(`${markers} execution failure marker(s) found`) : pass("no EVM, batch or extrinsic failure markers found");
}

async function verify(api) {
  const net = env("NET", "mainnet");
  const deployment = loadDeployments(net);
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", deployment.network.evmRpc));
  const network = await provider.getNetwork();

  console.log(`=== Verifying Uniswap v3: ${net} ===`);
  if (deployment.network.chainId && network.chainId.toString() !== deployment.network.chainId) {
    fail(`chain ID ${network.chainId}; deployment record is for ${deployment.network.chainId}`);
  } else {
    pass(`EVM chain ${network.chainId}, block ${await provider.getBlockNumber()}`);
  }

  console.log("\n--- deployed contracts ---");
  for (const [name, address] of Object.entries(deployment.uniswap)) {
    if (name === "weth9") continue;
    const code = await provider.getCode(address);
    code !== "0x" ? pass(`${name} has code at ${address}`) : fail(`${name} has no code at ${address}`);
  }

  const factory = new ethers.Contract(deployment.uniswap.v3CoreFactory, ABI.factory, provider);
  const expectedOwner = env("OWNER_ADDRESS", deployment.owner);
  console.log("\n--- governance ownership ---");
  equalAddress("factory.owner()", await factory.owner(), expectedOwner);
  const proxyAdmin = new ethers.Contract(deployment.uniswap.proxyAdmin, ["function owner() view returns (address)"], provider);
  equalAddress("proxyAdmin.owner()", await proxyAdmin.owner(), expectedOwner);

  console.log("\n--- pool ---");
  const ids = [Number(env("TOKEN_A", "1001")), Number(env("TOKEN_B", "222"))];
  const fee = Number(env("FEE", "3000"));
  const [addressA, addressB] = await Promise.all(ids.map((id) => resolveAssetAddress(api, id)));
  const [token0, token1] = sortTokens(addressA, addressB);
  const poolAddress = await factory.getPool(token0, token1, fee);
  if (poolAddress === ethers.ZeroAddress) {
    fail("factory has no launch pool");
    return;
  }
  pass(`pool ${poolAddress}`);
  const pool = new ethers.Contract(poolAddress, ABI.pool, provider);
  const [actual0, actual1, actualFee, slot0, liquidity, decimalsA, decimalsB] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.slot0(),
    pool.liquidity(),
    new ethers.Contract(addressA, ABI.erc20, provider).decimals(),
    new ethers.Contract(addressB, ABI.erc20, provider).decimals(),
  ]);
  equalAddress("pool.token0()", actual0, token0);
  equalAddress("pool.token1()", actual1, token1);
  Number(actualFee) === fee ? pass(`pool fee ${actualFee}`) : fail(`pool fee ${actualFee}; expected ${fee}`);
  slot0.sqrtPriceX96 > 0n ? pass(`pool initialized at tick ${slot0.tick}`) : fail("pool is not initialized");

  const expectedOrder = [env("EXPECT_TOKEN0"), env("EXPECT_TOKEN1")];
  if (expectedOrder[0] && expectedOrder[1]) {
    const [expected0, expected1] = await Promise.all(expectedOrder.map((id) => resolveAssetAddress(api, Number(id))));
    equalAddress("pinned token0", actual0, expected0);
    equalAddress("pinned token1", actual1, expected1);
  } else {
    fail("EXPECT_TOKEN0 and EXPECT_TOKEN1 are not configured");
  }

  const twap = Number(env("TWAP_WINDOW_SECS", "3600"));
  const blockSeconds = Number(env("BLOCK_TIME_SECS", "2"));
  const requiredCardinality = Math.ceil(twap / blockSeconds) + 1;
  Number(slot0.observationCardinalityNext) >= requiredCardinality
    ? pass(`observationCardinalityNext ${slot0.observationCardinalityNext} covers the configured TWAP window`)
    : fail(`observationCardinalityNext ${slot0.observationCardinalityNext}; need at least ${requiredCardinality}`);
  if (Number(slot0.observationCardinality) < Number(slot0.observationCardinalityNext)) {
    note(`TWAP history is still filling (${slot0.observationCardinality}/${slot0.observationCardinalityNext}); do not seed through a long-TWAP guard yet`);
  }

  const protocolFee = Number(env("FEE_PROTOCOL", "4"));
  const packed = Number(slot0.feeProtocol);
  const actualProtocol = [packed & 0x0f, packed >> 4];
  actualProtocol[0] === protocolFee && actualProtocol[1] === protocolFee
    ? pass(`protocol fee ${actualProtocol[0]}/${actualProtocol[1]}`)
    : fail(`protocol fee ${actualProtocol[0]}/${actualProtocol[1]}; expected ${protocolFee}/${protocolFee}`);
  liquidity > 0n ? pass(`in-range liquidity ${liquidity}`) : note("pool is correctly deployed but still unseeded");

  const aIsToken0 = token0.toLowerCase() === addressA.toLowerCase();
  const currentPrice = priceE18FromSqrtPriceX96(slot0.sqrtPriceX96, Number(decimalsA), Number(decimalsB), aIsToken0);
  pass(`pool price ${fmtE18(currentPrice)} TOKEN_B per TOKEN_A`);
  if (env("PRICE_FEED_A")) {
    try {
      const a = await readFeedE18(ethers, env("PRICE_FEED_A"), provider, Number(env("STALE_SECONDS", "28800")));
      const b = env("PRICE_FEED_B")
        ? await readFeedE18(ethers, env("PRICE_FEED_B"), provider, Number(env("STALE_SECONDS", "28800")))
        : { priceE18: 10n ** 18n };
      const oraclePrice = (a.priceE18 * 10n ** 18n) / b.priceE18;
      const divergence = currentPrice > oraclePrice
        ? ((currentPrice - oraclePrice) * 10_000n) / oraclePrice
        : ((oraclePrice - currentPrice) * 10_000n) / currentPrice;
      divergence <= BigInt(env("MAX_DIVERGENCE_BPS", "200"))
        ? pass(`pool/feed divergence ${divergence} bps`)
        : note(`pool/feed divergence ${divergence} bps; expected after trading, investigate before seeding`);
    } catch (error) {
      fail(`cannot validate price feed: ${error.message}`);
    }
  }

  console.log("\n--- runtime integration ---");
  (await emaTracked(api, ids)) ? pass("EMA oracle tracks the pair") : fail("EMA oracle does not track the pair");
  // All three addresses are set by one call and all three are load-bearing:
  // the executor resolves pools through the factory, prices through the quoter
  // and swaps through the swap router. A wrong address is silent — `getPool`
  // against a codeless address simply finds no pool — so check each one against
  // the deployment record rather than trusting the factory as a proxy for the set.
  const routerStorage = [
    ["uniswapV3Factory", "v3CoreFactory"],
    ["uniswapV3SwapRouter", "swapRouter02"],
    ["uniswapV3Quoter", "quoterV2"],
  ];
  if (api.query.parameters?.uniswapV3Factory) {
    for (const [storageKey, deploymentKey] of routerStorage) {
      const stored = await api.query.parameters[storageKey]();
      if (!stored.isSome) {
        fail(`parameters.${storageKey} is unset`);
        continue;
      }
      equalAddress(`parameters.${storageKey}`, stored.unwrap().toString(), deployment.uniswap[deploymentKey]);
    }
  } else {
    note("runtime has no Uniswap-v3 router parameter storage");
  }
}

async function main() {
  const api = await ApiPromise.create({
    provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud")),
    noInitWarn: true,
  });
  try {
    if (process.argv[2] === "events") {
      await scanEvents(api, Number(process.argv[3]), Number(process.argv[4] ?? 3));
    } else {
      await verify(api);
    }
  } finally {
    await api.disconnect();
  }
  console.log("");
  if (failures) throw new Error(`${failures} verification check(s) failed`);
  console.log("=== verification passed ===");
}

main().catch((error) => {
  console.error(`\nVerification failed: ${error.message}\n`);
  process.exit(1);
});
