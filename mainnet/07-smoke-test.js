/**
 * 07-smoke-test.js — end-to-end EVM smoke test of a deployed pool.
 *
 * Proves the whole stack actually trades, not just that the bytecode is on chain:
 *   1. QuoterV2.quoteExactInputSingle (staticcall — the quoter reverts by design)
 *   2. SwapRouter02.exactInputSingle  A -> B, actual out must match the quote
 *   3. the reverse swap               B -> A, price returns toward the start
 *   4. pool invariants: slot0 moved, fee growth accrued, observations recording
 *
 * Exits non-zero on any failed assertion, so it is usable as a gate in CI.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { env, requireEnv, resolveAssetAddress, sortTokens, priceE18FromSqrtPriceX96, fmtE18, ABI, loadDeployments } = require("./lib");

const U128_MAX = (1n << 128n) - 1n;

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];
const POOL_EXTRA = [
  ...ABI.pool,
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function observe(uint32[]) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
];
const ERC20_RW = [...ABI.erc20, "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function swap(router, wallet, erc, tokenIn, tokenOut, fee, amountIn, gasLimit, confirmations, label) {
  const routerAddr = await router.getAddress();
  if ((await erc.allowance(wallet.address, routerAddr)) < amountIn) {
    console.log(`  approve ${label} -> router`);
    await (await erc.approve(routerAddr, U128_MAX, { gasLimit })).wait(confirmations);
  }
  const params = {
    tokenIn, tokenOut, fee, recipient: wallet.address,
    amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  };
  const tx = await router.exactInputSingle(params, { gasLimit });
  const receipt = await tx.wait(confirmations);
  if (receipt.status !== 1) throw new Error(`${label} swap reverted (${tx.hash})`);
  return receipt;
}

async function main() {
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const gasLimit = BigInt(env("EVM_GAS_LIMIT", "10000000"));
  const confirmations = Number(env("CONFIRMATIONS", "3"));

  const assetA = Number(env("TOKEN_A", "1001"));
  const assetB = Number(env("TOKEN_B", "222"));
  const fee = Number(env("FEE", "3000"));
  // An Erc20-kind asset (aDOT, HOLLAR) lives at its registered contract, not at
  // the 0x…01++id alias — matching HydraErc20Mapping::asset_address. The alias
  // resolves to a different pool, and aDOT's alias reverts on transfer.
  const sub = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud"), 3000) });
  let addrA, addrB;
  try {
    [addrA, addrB] = await Promise.all([resolveAssetAddress(sub, assetA), resolveAssetAddress(sub, assetB)]);
  } finally {
    await sub.disconnect();
  }
  const [token0, token1] = sortTokens(addrA, addrB);
  const aIsToken0 = token0.toLowerCase() === addrA.toLowerCase();
  const amountIn = BigInt(requireEnv("SMOKE_AMOUNT_A"));

  const factory = new ethers.Contract(d.uniswap.v3CoreFactory, ABI.factory, provider);
  const poolAddr = await factory.getPool(token0, token1, fee);
  if (poolAddr === ethers.ZeroAddress) throw new Error("pool does not exist");
  const pool = new ethers.Contract(poolAddr, POOL_EXTRA, provider);

  const ercA = new ethers.Contract(addrA, ERC20_RW, wallet);
  const ercB = new ethers.Contract(addrB, ERC20_RW, wallet);
  const [symA, symB, decA, decB] = await Promise.all([ercA.symbol(), ercB.symbol(), ercA.decimals(), ercB.decimals()]);

  console.log(`=== Smoke test ${symA}/${symB} fee ${fee} on ${net} ===`);
  console.log(`  pool   ${poolAddr}`);
  console.log(`  router ${d.uniswap.swapRouter02}`);
  console.log(`  quoter ${d.uniswap.quoterV2}\n`);

  const before = {
    slot0: await pool.slot0(),
    liquidity: await pool.liquidity(),
    fg0: await pool.feeGrowthGlobal0X128(),
    fg1: await pool.feeGrowthGlobal1X128(),
    balA: await ercA.balanceOf(wallet.address),
    balB: await ercB.balanceOf(wallet.address),
    poolA: await ercA.balanceOf(poolAddr),
    poolB: await ercB.balanceOf(poolAddr),
  };
  const priceBefore = priceE18FromSqrtPriceX96(before.slot0.sqrtPriceX96, Number(decA), Number(decB), aIsToken0);
  console.log(`  start: tick ${before.slot0.tick}, price ${fmtE18(priceBefore)} ${symB}/${symA}, liquidity ${before.liquidity}`);
  console.log(`  pool reserves: ${ethers.formatUnits(before.poolA, decA)} ${symA} / ${ethers.formatUnits(before.poolB, decB)} ${symB}\n`);

  check("pool has in-range liquidity", before.liquidity > 0n, `${before.liquidity}`);
  check(
    "observation cardinality grown for TWAP",
    Number(before.slot0.observationCardinalityNext) > 1,
    `next=${before.slot0.observationCardinalityNext}, current=${before.slot0.observationCardinality}`
  );

  // 1. quote
  const quoter = new ethers.Contract(d.uniswap.quoterV2, QUOTER_ABI, provider);
  const quote = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: addrA, tokenOut: addrB, amountIn, fee, sqrtPriceLimitX96: 0n,
  });
  const quotedOut = quote[0];
  console.log(`\n  quote: ${ethers.formatUnits(amountIn, decA)} ${symA} -> ${ethers.formatUnits(quotedOut, decB)} ${symB} (ticks crossed ${quote[2]})`);
  check("QuoterV2 returns a non-zero quote", quotedOut > 0n, `${quotedOut}`);

  // 2. forward swap
  const router = new ethers.Contract(d.uniswap.swapRouter02, ROUTER_ABI, wallet);
  console.log(`\n  swap ${symA} -> ${symB}...`);
  await swap(router, wallet, ercA, addrA, addrB, fee, amountIn, gasLimit, confirmations, symA);

  const midBalA = await ercA.balanceOf(wallet.address);
  const midBalB = await ercB.balanceOf(wallet.address);
  const spentA = before.balA - midBalA;
  const gotB = midBalB - before.balB;
  console.log(`  spent ${ethers.formatUnits(spentA, decA)} ${symA}, received ${ethers.formatUnits(gotB, decB)} ${symB}`);

  // The point of this check is to catch the router leaving input UNSPENT — a partial
  // fill, which would be a real bug and shows up as a large shortfall. It is not an
  // exact-equality check, because aDOT is an Aave aToken: balances are stored scaled
  // by the reserve's liquidity index (ray, 1e27) and `balanceOf` multiplies back out,
  // so moving an exact amount round-trips through a divide and loses a few units.
  // Measured on lark4: 10000000000 in, 9999987770 moved — 1.2 ppm. HOLLAR is a plain
  // ERC20 and the return leg below is exact, which is what pins this on the aToken.
  // Overspending is never acceptable and stays a hard failure.
  const SPEND_TOLERANCE_PPM = 10n;
  const shortfall = amountIn > spentA ? amountIn - spentA : 0n;
  const shortfallPpm = (shortfall * 1_000_000n) / amountIn;
  check(
    "forward swap consumed amountIn (within aToken scaling tolerance)",
    spentA <= amountIn && shortfallPpm <= SPEND_TOLERANCE_PPM,
    `${spentA} vs ${amountIn} (shortfall ${shortfall} = ${shortfallPpm} ppm, tolerance ${SPEND_TOLERANCE_PPM} ppm)`
  );
  check("forward swap produced output", gotB > 0n, `${gotB}`);
  const diff = gotB > quotedOut ? gotB - quotedOut : quotedOut - gotB;
  const driftBps = quotedOut === 0n ? 10000n : (diff * 10000n) / quotedOut;
  check("executed output matches QuoterV2", driftBps <= 1n, `${driftBps} bps drift (quote ${quotedOut}, actual ${gotB})`);

  const mid = { slot0: await pool.slot0(), fg0: await pool.feeGrowthGlobal0X128(), fg1: await pool.feeGrowthGlobal1X128() };
  const priceMid = priceE18FromSqrtPriceX96(mid.slot0.sqrtPriceX96, Number(decA), Number(decB), aIsToken0);
  console.log(`  after: tick ${mid.slot0.tick}, price ${fmtE18(priceMid)} ${symB}/${symA}`);
  check("price moved against the seller", priceMid < priceBefore, `${fmtE18(priceBefore)} -> ${fmtE18(priceMid)}`);
  const feeSide = aIsToken0 ? mid.fg0 > before.fg0 : mid.fg1 > before.fg1;
  check("LP fee growth accrued on the input side", feeSide, `fg0 ${before.fg0}->${mid.fg0}, fg1 ${before.fg1}->${mid.fg1}`);

  // 3. reverse swap
  console.log(`\n  swap ${symB} -> ${symA} (return leg)...`);
  await swap(router, wallet, ercB, addrB, addrA, fee, gotB, gasLimit, confirmations, symB);

  const endBalA = await ercA.balanceOf(wallet.address);
  const endBalB = await ercB.balanceOf(wallet.address);
  const backA = endBalA - midBalA;
  console.log(`  received back ${ethers.formatUnits(backA, decA)} ${symA}`);
  check("reverse swap produced output", backA > 0n, `${backA}`);
  check("reverse swap spent the full leg", midBalB - endBalB === gotB, `${midBalB - endBalB} vs ${gotB}`);

  // round trip must lose roughly 2x the fee (0.3% each way) and never gain
  const lossBps = ((amountIn - backA) * 10000n) / amountIn;
  const expectedBps = BigInt(Math.round((fee / 1_000_000) * 2 * 10000));
  check(
    "round trip loses ~2x the pool fee and never profits",
    backA < amountIn && lossBps >= expectedBps - 5n && lossBps <= expectedBps + 30n,
    `${lossBps} bps lost (expected ~${expectedBps})`
  );

  const end = { slot0: await pool.slot0(), fg0: await pool.feeGrowthGlobal0X128(), fg1: await pool.feeGrowthGlobal1X128() };
  const priceEnd = priceE18FromSqrtPriceX96(end.slot0.sqrtPriceX96, Number(decA), Number(decB), aIsToken0);
  console.log(`  final: tick ${end.slot0.tick}, price ${fmtE18(priceEnd)} ${symB}/${symA}`);
  check("price recovered toward the start", priceEnd > priceMid, `${fmtE18(priceMid)} -> ${fmtE18(priceEnd)}`);
  const feeOther = aIsToken0 ? end.fg1 > mid.fg1 : end.fg0 > mid.fg0;
  check("LP fee growth accrued on the other side too", feeOther, `fg0 ${mid.fg0}->${end.fg0}, fg1 ${mid.fg1}->${end.fg1}`);

  // 4. TWAP oracle is actually recording
  try {
    const obs = await pool.observe([0, 60]);
    const delta = BigInt(obs[0][0].toString()) - BigInt(obs[0][1].toString());
    check("observe() returns a usable TWAP window", true, `60s avg tick ${delta / 60n}`);
  } catch (e) {
    check("observe() returns a usable TWAP window", false, e.shortMessage || e.message);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) {
    console.log(failed.map((f) => `  FAILED: ${f.name} — ${f.detail}`).join("\n"));
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED");
}

main().catch((e) => {
  console.error("\n  smoke test FAILED:", e.message, "\n");
  process.exit(1);
});
