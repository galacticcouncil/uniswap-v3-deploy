/**
 * 06-seed-position.js — mint a liquidity position directly through the
 * NonfungiblePositionManager.
 *
 * This is the *testing* seeding path. Production liquidity goes through the
 * Gamma UniProxy (gamma-hypervisor) so the ClearingV2 deposit guards apply;
 * this script exists so a freshly created pool has depth to smoke-test against.
 *
 *   node 06-seed-position.js              # full range
 *   node 06-seed-position.js <lo> <hi>    # explicit ticks (must divide spacing)
 *
 * lark gotchas baked in:
 *   - approvals use the u128 sentinel (2^128-1); MaxUint256 overflows the
 *     asset precompile, whose `approve(address,uint256)` reads a u128 Balance
 *   - explicit gas limits (lark's estimateGas under-shoots CREATE/mint)
 */

const { ethers } = require("ethers");
const { env, requireEnv, assetToEvmAddress, sortTokens, ABI, loadDeployments, saveJson } = require("./lib");

const U128_MAX = (1n << 128n) - 1n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

const NPM_ABI = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
];
const ERC20_RW = [...ABI.erc20, "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];

const floorToSpacing = (t, s) => Math.floor(t / s) * s;
const ceilToSpacing = (t, s) => Math.ceil(t / s) * s;

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
  const addrA = assetToEvmAddress(assetA);
  const addrB = assetToEvmAddress(assetB);
  const [token0, token1] = sortTokens(addrA, addrB);
  const aIsToken0 = token0.toLowerCase() === addrA.toLowerCase();

  const factory = new ethers.Contract(d.uniswap.v3CoreFactory, ABI.factory, provider);
  const pool = await factory.getPool(token0, token1, fee);
  if (pool === ethers.ZeroAddress) throw new Error("pool does not exist — run 03-create-pool.js first");
  const poolC = new ethers.Contract(pool, ABI.pool, provider);
  const spacing = Number(await factory.feeAmountTickSpacing(fee));

  const seedA = BigInt(requireEnv("SEED_A"));
  const seedB = BigInt(requireEnv("SEED_B"));
  const amount0 = aIsToken0 ? seedA : seedB;
  const amount1 = aIsToken0 ? seedB : seedA;

  const [tickLower, tickUpper] =
    process.argv.length >= 4
      ? [Number(process.argv[2]), Number(process.argv[3])]
      : [ceilToSpacing(MIN_TICK, spacing), floorToSpacing(MAX_TICK, spacing)];
  if (tickLower % spacing !== 0 || tickUpper % spacing !== 0) {
    throw new Error(`ticks must be multiples of the ${spacing} spacing`);
  }

  const erc0 = new ethers.Contract(token0, ERC20_RW, wallet);
  const erc1 = new ethers.Contract(token1, ERC20_RW, wallet);
  const [sym0, sym1, dec0, dec1, bal0, bal1, slot0] = await Promise.all([
    erc0.symbol(), erc1.symbol(), erc0.decimals(), erc1.decimals(),
    erc0.balanceOf(wallet.address), erc1.balanceOf(wallet.address), poolC.slot0(),
  ]);

  console.log(`=== Seed ${sym0}/${sym1} fee ${fee} on ${net} ===`);
  console.log(`  pool     ${pool}  (tick ${slot0.tick}, spacing ${spacing})`);
  console.log(`  range    [${tickLower}, ${tickUpper}]${tickLower === ceilToSpacing(MIN_TICK, spacing) ? " (full range)" : ""}`);
  console.log(`  desired  ${ethers.formatUnits(amount0, dec0)} ${sym0} / ${ethers.formatUnits(amount1, dec1)} ${sym1}`);
  console.log(`  balance  ${ethers.formatUnits(bal0, dec0)} ${sym0} / ${ethers.formatUnits(bal1, dec1)} ${sym1}`);
  if (bal0 < amount0 || bal1 < amount1) throw new Error("insufficient balance — run 05-testnet-govern.js");

  const npmAddr = d.uniswap.nonfungiblePositionManager;
  for (const [erc, sym, amount] of [[erc0, sym0, amount0], [erc1, sym1, amount1]]) {
    const current = await erc.allowance(wallet.address, npmAddr);
    if (current >= amount) {
      console.log(`  allowance ${sym} already ${current}`);
      continue;
    }
    console.log(`  approve ${sym} -> NPM (u128 sentinel)`);
    const tx = await erc.approve(npmAddr, U128_MAX, { gasLimit });
    await tx.wait(confirmations);
  }

  const npm = new ethers.Contract(npmAddr, NPM_ABI, wallet);
  const params = {
    token0, token1, fee, tickLower, tickUpper,
    amount0Desired: amount0, amount1Desired: amount1,
    amount0Min: 0n, amount1Min: 0n,
    recipient: wallet.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  console.log("  mint...");
  const tx = await npm.mint(params, { gasLimit });
  const receipt = await tx.wait(confirmations);
  if (receipt.status !== 1) throw new Error(`mint reverted (${tx.hash})`);
  console.log(`  tx ${receipt.hash}`);

  // recover tokenId from the NPM Transfer(0x0 -> recipient) log
  let tokenId;
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === npmAddr.toLowerCase() && log.topics[0] === transferTopic) {
      tokenId = BigInt(log.topics[3]);
      break;
    }
  }

  const [liquidity, after, bal0After, bal1After] = await Promise.all([
    poolC.liquidity(), poolC.slot0(), erc0.balanceOf(wallet.address), erc1.balanceOf(wallet.address),
  ]);
  const used0 = bal0 - bal0After;
  const used1 = bal1 - bal1After;
  console.log(`\n=== seeded ===`);
  console.log(`  tokenId          ${tokenId ?? "(not found in logs)"}`);
  console.log(`  in-range liq     ${liquidity}`);
  console.log(`  deposited        ${ethers.formatUnits(used0, dec0)} ${sym0} / ${ethers.formatUnits(used1, dec1)} ${sym1}`);
  console.log(`  pool tick        ${after.tick}`);
  if (liquidity === 0n) throw new Error("pool still reports zero in-range liquidity");

  saveJson(`deployments/${net}-positions.json`, {
    pool, fee, tickLower, tickUpper,
    tokenId: tokenId?.toString(),
    liquidity: liquidity.toString(),
    deposited: { [sym0]: used0.toString(), [sym1]: used1.toString() },
  });
}

main().catch((e) => {
  console.error("\n  seed FAILED:", e.message, "\n");
  process.exit(1);
});
