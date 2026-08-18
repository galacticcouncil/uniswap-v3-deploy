/**
 * 03-create-pool.js — create + initialize the pool at the ORACLE price and
 * grow the observation ring buffer so TWAP (ClearingV2 deposit guard, keeper
 * gates) actually works. No liquidity is added here — seeding goes through
 * the Gamma UniProxy in gamma-hypervisor.
 *
 * Price resolution (TOKEN_B per 1 TOKEN_A, human units):
 *   - DIA_FEED + DIA_KEY          -> DIA value (1e8). TOKEN_B assumed 1 USD,
 *     or set DIA_KEY_B for a second feed and the ratio is used.
 *   - PRICE                       -> manual decimal, e.g. 4.2
 *   - both                        -> DIA wins, abort if they diverge more than
 *     MAX_DIVERGENCE_BPS (a wrong init price is free money for the first arber).
 */

const { ethers } = require("ethers");
const {
  env,
  requireEnv,
  assetToEvmAddress,
  sortTokens,
  parsePriceToE18,
  sqrtPriceX96FromPrice,
  priceE18FromSqrtPriceX96,
  fmtE18,
  ABI,
  loadDeployments,
  saveJson,
} = require("./lib");

const divergenceBps = (a, b) => (a > b ? ((a - b) * 10_000n) / b : ((b - a) * 10_000n) / a);

/**
 * A v3 pool has no "pair" — it has token0/token1, assigned by sorting the two raw
 * addresses. On Hydration the address is the asset id in its last 4 bytes, so that
 * sort is an ID sort, and the ordering FLIPS between the DOT test pair and the aDOT
 * launch pair: 5 < 222 makes DOT token0, but 222 < 1001 makes HOLLAR token0 and aDOT
 * token1. Every tick sign downstream inverts with it and nothing reverts to say so —
 * aDOT and DOT are both 10 decimals, so the wrong pool looks right until the
 * Hypervisor points at it. The sort is dynamic (correct); this pins what we MEANT.
 */
function assertOrdering(token0, token1) {
  const expect0 = env("EXPECT_TOKEN0");
  const expect1 = env("EXPECT_TOKEN1");
  if (!expect0 || !expect1) {
    console.log("  ! EXPECT_TOKEN0/EXPECT_TOKEN1 unset — token ordering NOT asserted");
    return;
  }
  const want0 = assetToEvmAddress(Number(expect0));
  const want1 = assetToEvmAddress(Number(expect1));
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

async function resolvePriceE18(provider) {
  const manual = env("PRICE") ? parsePriceToE18(env("PRICE")) : undefined;
  let dia;
  if (env("DIA_FEED")) {
    const feed = new ethers.Contract(env("DIA_FEED"), ABI.dia, provider);
    const stale = Number(env("STALE_SECONDS", "3600"));
    const read = async (key) => {
      const [value, ts] = await feed.getValue(key);
      const age = Math.floor(Date.now() / 1000) - Number(ts);
      if (age > stale) throw new Error(`DIA ${key} is stale (${age}s old)`);
      if (value === 0n) throw new Error(`DIA ${key} returned 0`);
      console.log(`  DIA ${key} = ${Number(value) / 1e8} (age ${age}s)`);
      return value; // 1e8
    };
    const a = await read(env("DIA_KEY", "DOT/USD"));
    dia = env("DIA_KEY_B") ? (a * 10n ** 18n) / (await read(env("DIA_KEY_B"))) : a * 10n ** 10n;
  }
  if (dia !== undefined && manual !== undefined) {
    const d = divergenceBps(dia, manual);
    if (d > BigInt(env("MAX_DIVERGENCE_BPS", "200"))) {
      throw new Error(`DIA (${fmtE18(dia)}) vs PRICE (${fmtE18(manual)}) diverge by ${d} bps — aborting`);
    }
    console.log(`  cross-check ok (${d} bps)`);
  }
  const price = dia ?? manual;
  if (price === undefined) throw new Error("set DIA_FEED and/or PRICE");
  return price;
}

async function main() {
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);

  const assetA = Number(env("TOKEN_A", "1001"));
  const assetB = Number(env("TOKEN_B", "222"));
  const fee = Number(env("FEE", "3000"));
  const addrA = assetToEvmAddress(assetA);
  const addrB = assetToEvmAddress(assetB);
  const [token0, token1] = sortTokens(addrA, addrB);
  const aIsToken0 = token0.toLowerCase() === addrA.toLowerCase();
  assertOrdering(token0, token1);

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
    throw new Error(`fee tier ${fee} not enabled on factory — 04-owner-ops.js enable-fee-tier`);
  }

  let pool = await factory.getPool(token0, token1, fee);
  if (pool === ethers.ZeroAddress) {
    console.log("  creating pool...");
    await (await factory.createPool(token0, token1, fee)).wait();
    pool = await factory.getPool(token0, token1, fee);
    if (pool === ethers.ZeroAddress) throw new Error("pool creation failed");
  }
  console.log(`  pool ${pool}`);

  const poolC = new ethers.Contract(pool, ABI.pool, wallet);
  let s = await poolC.slot0().catch(() => null);
  if (!s || s.sqrtPriceX96 === 0n) {
    console.log(`  initialize sqrtPriceX96 ${sqrtPriceX96}`);
    await (await poolC.initialize(sqrtPriceX96)).wait();
    s = await poolC.slot0();
  } else {
    const current = priceE18FromSqrtPriceX96(s.sqrtPriceX96, Number(decA), Number(decB), aIsToken0);
    const div = divergenceBps(current, priceE18);
    console.log(`  already initialized at ${fmtE18(current)} ${symB}/${symA} (${div} bps from oracle)`);
    if (div > BigInt(env("MAX_DIVERGENCE_BPS", "200"))) {
      console.log("  ! pool price is far from oracle — do NOT seed until arbed/checked");
    }
  }

  // Grow the TWAP ring buffer in chunks (each new slot is an SSTORE; one big
  // jump can exceed the block gas limit).
  const target = Number(env("OBS_CARDINALITY", "600"));
  const chunk = Number(env("OBS_CHUNK", "250"));
  let next = Number(s.observationCardinalityNext);
  while (next < target) {
    const step = Math.min(target, next + chunk);
    console.log(`  observation cardinality ${next} -> ${step}...`);
    await (await poolC.increaseObservationCardinalityNext(step)).wait();
    next = Number((await poolC.slot0()).observationCardinalityNext);
  }
  console.log(`  observation cardinality next: ${next} (~${(next * 6) / 60} min of TWAP at 6s blocks)`);

  const final = await poolC.slot0();
  const outPath = saveJson(`deployments/${net}-pools.json`, {
    ...((() => { try { return loadDeployments(`${net}-pools`); } catch { return {}; } })()),
    [`${assetA}-${assetB}-${fee}`]: {
      pool,
      token0,
      token1,
      fee,
      tick: Number(final.tick),
      sqrtPriceX96: final.sqrtPriceX96.toString(),
      observationCardinalityNext: next,
    },
  });
  console.log(`  Wrote ${outPath}`);
  console.log("=== Done — pool is live, unseeded. Next: gamma-hypervisor vault + UniProxy deposit. ===");
}

main().catch((e) => {
  console.error("\n  create-pool FAILED:", e.message, "\n");
  process.exit(1);
});
