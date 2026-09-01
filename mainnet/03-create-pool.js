/**
 * Create, initialize and prepare the one production pool. No liquidity is
 * added here: production seeding belongs to the Gamma deployment and is kept
 * deliberately outside this irreversible v3 deployment.
 *
 * Price resolution (TOKEN_B per 1 TOKEN_A, human units):
 *   - PRICE_FEED_A                -> TOKEN_A/USD. TOKEN_B assumed 1 USD, or set
 *     PRICE_FEED_B for a second feed and the ratio is used.
 *   - PRICE                       -> manual decimal, e.g. 4.2
 *   - both                        -> the feed wins, abort if they diverge more
 *     than MAX_DIVERGENCE_BPS (a wrong init price is free money for the first arber).
 *
 * Feeds use Chainlink AggregatorV3's latestRoundData interface.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const {
  env,
  requireEnv,
  readFeedE18,
  resolveAssetAddress,
  sortTokens,
  parsePriceToE18,
  sqrtPriceX96FromPrice,
  priceE18FromSqrtPriceX96,
  fmtE18,
  ABI,
  gasOverrides,
  loadDeployments,
  saveJson,
} = require("./lib");

// Relative gap between two 1e18 prices, in bps. Both must be positive: the
// smaller one is the divisor, so a zero PRICE alongside a live feed would
// otherwise throw a bare `RangeError: Division by zero` instead of saying which
// input was bad.
const divergenceBps = (a, b) => {
  if (a <= 0n || b <= 0n) {
    throw new Error(`cannot compare prices ${fmtE18(a)} and ${fmtE18(b)} — both must be positive`);
  }
  return a > b ? ((a - b) * 10_000n) / b : ((b - a) * 10_000n) / a;
};

// Seconds of history a FULL ring of `cardinality` slots covers. The oldest entry
// is `(index + 1) % cardinality` — one step forward in the ring, i.e. C-1 slots
// behind the newest — so it is (C-1) intervals, not C. That one slot is the
// difference between 600 (3594s, reverts on a 3600s window) and 601.
const coverage = (cardinality, blockSecs) => Math.max(0, cardinality - 1) * blockSecs;

function assertOrdering(token0, token1, want0, want1) {
  const expect0 = env("EXPECT_TOKEN0");
  const expect1 = env("EXPECT_TOKEN1");
  if (!expect0 || !expect1) {
    if (env("NET", "mainnet") === "mainnet") {
      throw new Error("EXPECT_TOKEN0 and EXPECT_TOKEN1 are required on mainnet");
    }
    console.log("  ! token order is not pinned (set EXPECT_TOKEN0/EXPECT_TOKEN1 for this non-mainnet run)");
    return;
  }
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!same(token0, want0) || !same(token1, want1)) {
    throw new Error(
      `token ordering mismatch — pool sorts to token0=${token0} token1=${token1}, ` +
        `but EXPECT_TOKEN0=${expect0} EXPECT_TOKEN1=${expect1} means ${want0} / ${want1}. ` +
        `Check TOKEN_A/TOKEN_B (aDOT is 1001, DOT is 5).`
    );
  }
  console.log(`  ordering asserted: token0=asset ${expect0}, token1=asset ${expect1}`);
}

async function waitForSuccess(tx, confirmations, label) {
  const receipt = await tx.wait(confirmations, 15 * 60_000);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} reverted or timed out (${tx.hash})`);
  console.log(`  ${label}: ${receipt.hash}`);
  return receipt;
}

async function resolvePriceE18(provider) {
  const manual = env("PRICE") ? parsePriceToE18(env("PRICE")) : undefined;
  let oracle;
  if (env("PRICE_FEED_A")) {
    const stale = Number(env("STALE_SECONDS", "3600"));
    const read = async (label, address) => {
      const r = await readFeedE18(ethers, address, provider, stale);
      console.log(`  ${label} ${address} = ${fmtE18(r.priceE18)} USD (age ${r.age}s, ${r.decimals} dec)`);
      return r.priceE18;
    };
    const a = await read("feed A", env("PRICE_FEED_A"));
    if (env("PRICE_FEED_B")) {
      const b = await read("feed B", env("PRICE_FEED_B"));
      // Both are 1e18 USD prices; TOKEN_B per TOKEN_A is their ratio.
      oracle = (a * 10n ** 18n) / b;
    } else {
      // No feed for TOKEN_B: it is the USD-pegged side (HOLLAR), so A/USD is the
      // price directly. Document the assumption rather than hiding it.
      console.log(`  PRICE_FEED_B unset — TOKEN_B assumed 1 USD`);
      oracle = a;
    }
  }
  if (oracle !== undefined && manual !== undefined) {
    const d = divergenceBps(oracle, manual);
    if (d > BigInt(env("MAX_DIVERGENCE_BPS", "200"))) {
      throw new Error(`feed (${fmtE18(oracle)}) vs PRICE (${fmtE18(manual)}) diverge by ${d} bps — aborting`);
    }
    console.log(`  cross-check ok (${d} bps)`);
  }
  const price = oracle ?? manual;
  if (price === undefined) throw new Error("set PRICE_FEED_A and/or PRICE");
  return price;
}

async function main() {
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const confirmations = Number(env("CONFIRMATIONS", "2"));
  if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error("CONFIRMATIONS must be a positive integer");

  const assetA = Number(env("TOKEN_A", "1001"));
  const assetB = Number(env("TOKEN_B", "222"));
  const fee = Number(env("FEE", "3000"));
  // Resolve the way the RUNTIME does: an Erc20-kind asset (aDOT, HOLLAR) lives at
  // its registered contract, not at the 0x…01++id alias. Using the alias would
  // create a pool the router's find_pool can never resolve — and for aDOT the
  // alias reverts on transfer, so it could not be seeded either.
  const sub = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud"), 3000) });
  let addrA, addrB, wantAddr0, wantAddr1;
  try {
    [addrA, addrB] = await Promise.all([resolveAssetAddress(sub, assetA), resolveAssetAddress(sub, assetB)]);
    // Resolve the expectation the same way, so the assertion compares like with like.
    const e0 = env("EXPECT_TOKEN0"), e1 = env("EXPECT_TOKEN1");
    if (e0 && e1) {
      [wantAddr0, wantAddr1] = await Promise.all([
        resolveAssetAddress(sub, Number(e0)),
        resolveAssetAddress(sub, Number(e1)),
      ]);
    }
  } finally {
    await sub.disconnect();
  }
  console.log(`  token addresses: ${assetA} -> ${addrA}`);
  console.log(`                   ${assetB} -> ${addrB}`);
  const [token0, token1] = sortTokens(addrA, addrB);
  const aIsToken0 = token0.toLowerCase() === addrA.toLowerCase();
  assertOrdering(token0, token1, wantAddr0, wantAddr1);

  const ercA = new ethers.Contract(addrA, ABI.erc20, provider);
  const ercB = new ethers.Contract(addrB, ABI.erc20, provider);
  const [decA, decB, symA, symB] = await Promise.all([ercA.decimals(), ercB.decimals(), ercA.symbol(), ercB.symbol()]);
  console.log(`=== Pool ${symA}(${assetA})/${symB}(${assetB}) fee ${fee} on ${net} ===`);
  console.log(`  token0 ${token0}  token1 ${token1}  (${symA} is token${aIsToken0 ? 0 : 1})`);

  const priceE18 = await resolvePriceE18(provider);
  console.log(`  init price: ${fmtE18(priceE18)} ${symB} per ${symA}`);
  const sqrtPriceX96 = sqrtPriceX96FromPrice(priceE18, Number(decA), Number(decB), aIsToken0);

  const factory = new ethers.Contract(d.uniswap.v3CoreFactory, ABI.factory, wallet);
  if ((await factory.feeAmountTickSpacing(fee)) === 0n) {
    throw new Error(`fee tier ${fee} is not enabled on the factory`);
  }

  let pool = await factory.getPool(token0, token1, fee);
  if (pool === ethers.ZeroAddress) {
    console.log("  creating pool...");
    await waitForSuccess(await factory.createPool(token0, token1, fee, await gasOverrides(provider)), confirmations, "createPool");
    pool = await factory.getPool(token0, token1, fee);
    if (pool === ethers.ZeroAddress) throw new Error("pool creation failed");
  }
  console.log(`  pool ${pool}`);

  const poolC = new ethers.Contract(pool, ABI.pool, wallet);
  let s = await poolC.slot0().catch(() => null);
  if (!s || s.sqrtPriceX96 === 0n) {
    console.log(`  initialize sqrtPriceX96 ${sqrtPriceX96}`);
    await waitForSuccess(await poolC.initialize(sqrtPriceX96, await gasOverrides(provider)), confirmations, "initialize");
    s = await poolC.slot0();
  } else {
    const current = priceE18FromSqrtPriceX96(s.sqrtPriceX96, Number(decA), Number(decB), aIsToken0);
    const div = divergenceBps(current, priceE18);
    console.log(`  already initialized at ${fmtE18(current)} ${symB}/${symA} (${div} bps from oracle)`);
    if (div > BigInt(env("MAX_DIVERGENCE_BPS", "200"))) {
      console.log("  ! pool price is far from oracle — do NOT seed until arbed/checked");
    }
  }

  // Grow the TWAP observation ring in chunks (each new slot is an SSTORE; one
  // big jump can exceed the block gas limit).
  const target = Number(env("OBS_CARDINALITY", "2000"));
  let chunk = Number(env("OBS_CHUNK", "250"));
  const windowSecs = Number(env("TWAP_WINDOW_SECS", "3600"));
  const blockSecs = Number(env("BLOCK_TIME_SECS", "2"));
  const minCardinality = Math.ceil(windowSecs / blockSecs) + 1;
  if (target < minCardinality) {
    throw new Error(
      `OBS_CARDINALITY=${target} is too small for a ${windowSecs}s TWAP at ${blockSecs}s blocks. ` +
        `A full ring of C slots covers (C-1)*${blockSecs} = ${coverage(target, blockSecs)}s, and observe() ` +
        `REVERTS ('OLD') past that — it does not return a shorter average. Minimum is ${minCardinality}; ` +
        `use ${minCardinality + 120} for headroom.`
    );
  }

  // Each new observation slot is a cold zero->nonzero SSTORE inside Oracle.grow's
  // loop, and the cost is exactly linear: a local-fork measurement was about
  // 42,456 gas/slot (+25 slots = 1,061,400; +50 = 2,122,800).
  // So a 250-slot chunk needs 10,614,000 — just over a 10M EVM_GAS_LIMIT, and it
  // fails as a status-0 receipt that burned the entire limit, with no revert
  // reason. Clamp the chunk to what the gas limit can actually pay for instead
  // of letting that happen.
  const GAS_PER_OBSERVATION_SLOT = 42456;
  const gasLimit = Number(env("EVM_GAS_LIMIT", "15000000"));
  const maxChunk = Math.floor((gasLimit * 0.9) / GAS_PER_OBSERVATION_SLOT);
  if (maxChunk < 1) {
    throw new Error(`EVM_GAS_LIMIT=${gasLimit} cannot grow even one observation slot (~${GAS_PER_OBSERVATION_SLOT} gas)`);
  }
  if (chunk > maxChunk) {
    console.log(
      `  ! OBS_CHUNK ${chunk} needs ~${(chunk * GAS_PER_OBSERVATION_SLOT).toLocaleString("en-US")} gas, ` +
        `over EVM_GAS_LIMIT ${gasLimit.toLocaleString("en-US")} — clamping to ${maxChunk}`
    );
    chunk = maxChunk;
  }
  console.log(
    `  growing ring to ${target} in chunks of ${chunk} ` +
      `(~${(chunk * GAS_PER_OBSERVATION_SLOT).toLocaleString("en-US")} gas/tx, ` +
      `~${Math.ceil((target - Number(s.observationCardinalityNext)) / chunk)} txs)`
  );

  let next = Number(s.observationCardinalityNext);
  while (next < target) {
    const step = Math.min(target, next + chunk);
    console.log(`  observation cardinality ${next} -> ${step}...`);
    await waitForSuccess(
      await poolC.increaseObservationCardinalityNext(step, await gasOverrides(provider)),
      confirmations,
      `increase observation cardinality to ${step}`
    );
    next = Number((await poolC.slot0()).observationCardinalityNext);
  }
  const covers = coverage(next, blockSecs);
  console.log(
    `  observation cardinality next: ${next} — covers ${covers}s ` +
      `(${(covers / 60).toFixed(1)} min) at ${blockSecs}s blocks, vs ${windowSecs}s window ` +
      `(+${covers - windowSecs}s headroom)`
  );
  console.log(
    `  ! slots are RESERVED, not filled — they populate one per block that trades. Until the pool has\n` +
      `    ${windowSecs}s of trading history, observe(${windowSecs}) reverts and the Gamma seed deposit\n` +
      `    WILL FAIL. Wait it out, or lower ClearingV2 twapInterval for the seed and raise it after.`
  );

  // Protocol fee. slot0 packs it as one uint8: token1 in the high nibble, token0
  // in the low one, and each is a DENOMINATOR (4 = 1/4 = the contract maximum,
  // 0 = off). Setting it is an owner action, so it cannot happen here — but a
  // pool that reaches launch still sitting at 0 is the failure we care about.
  const final = await poolC.slot0();
  const fpWant = Number(env("FEE_PROTOCOL", "4"));
  const fp0 = Number(final.feeProtocol) & 0x0f;
  const fp1 = Number(final.feeProtocol) >> 4;
  const fpDesc = (n) => (n ? `1/${n}` : "OFF");
  if (fp0 === fpWant && fp1 === fpWant) {
    console.log(`  protocol fee: ${fpDesc(fp0)} / ${fpDesc(fp1)} (matches FEE_PROTOCOL=${fpWant})`);
  } else {
    console.log(
        `  ! protocol fee is ${fpDesc(fp0)} / ${fpDesc(fp1)}, expected ${fpDesc(fpWant)} on both —` +
        ` include it in: node 01-governance-calldata.js launch ${pool}`
    );
  }

  const outPath = saveJson(`deployments/${net}-pool.json`, {
    chainId: (await provider.getNetwork()).chainId.toString(),
    pool,
    token0,
    token1,
    assetIds: [assetA, assetB],
    fee,
    tick: Number(final.tick),
    sqrtPriceX96: final.sqrtPriceX96.toString(),
    observationCardinalityNext: next,
    feeProtocol: [fp0, fp1],
  });
  console.log(`  Wrote ${outPath}`);
  console.log("=== Pool is live and unseeded. Generate the governance launch bundle next. ===");
}

main().catch((e) => {
  console.error("\n  create-pool FAILED:", e.message, "\n");
  process.exit(1);
});
