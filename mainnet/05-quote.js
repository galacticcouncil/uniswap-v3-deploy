/**
 * 05-quote.js — read-only: quote one pool through BOTH routers once its seed is
 * in the pool (runbook §5 step 14). Nothing is signed or sent.
 *
 *   ENV_FILE=.env.pools POOL_FILE=pools/atbtc-hollar.env npm run quote
 *
 * EVM: QuoterV2.quoteExactInputSingle, TOKEN_B -> TOKEN_A.
 * Substrate: router.sell over [UniswapV3(FEE)] through the runtime's DryRunApi,
 * from QUOTE_FROM (default: the treasury, which holds HOLLAR). That is the exact
 * call a user's trade makes, executed and thrown away.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { env, loadDeployments, resolveAssetAddress, sortTokens, ABI } = require("./lib");

// pallet-treasury's account ("modlpy/trsry"); its EVM address holds the treasury's HOLLAR.
const TREASURY = "0x6d6f646c70792f74727372790000000000000000000000000000000000000000";
const XCM_VERSION = 4;
const QUOTER = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
];
const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
// Runtime 447 serves DryRunApi v2 (it adds the XCM version argument); this
// @polkadot/api only ships v1, and metadata v14 cannot describe it, so say it here.
// The origin is declared too: the library's default OriginCaller puts `system`
// at index 0, but Hydration's System pallet is index 1, and a wrong byte there
// makes the runtime trap while decoding.
const TYPES = {
  QuoteOrigin: { _enum: { __Unused0: "Null", system: "QuoteRawOrigin" } },
  QuoteRawOrigin: { _enum: { Root: "Null", Signed: "AccountId32", None: "Null" } },
};
const DRY_RUN_API_V2 = {
  DryRunApi: [
    {
      methods: {
        dry_run_call: {
          description: "Dry run call",
          params: [
            { name: "origin", type: "QuoteOrigin" },
            { name: "call", type: "RuntimeCall" },
            { name: "resultXcmsVersion", type: "u32" },
          ],
          type: "Result<CallDryRunEffects, XcmDryRunApiError>",
        },
      },
      version: 2,
    },
  ],
};

/**
 * amount_out of the router.Executed event among a dry run's events, or undefined.
 * The events come back as raw { index, data }, so match the index from metadata.
 */
function executedAmountOut(api, events) {
  const pallet = api.runtimeMetadata.asLatest.pallets.find((p) => p.name.toString() === "Router");
  const executed = api.events.router.Executed.meta;
  const index = "0x" + Buffer.from([pallet.index.toNumber(), executed.index.toNumber()]).toString("hex");
  const field = executed.fields.findIndex((f) => f.name.toString() === "amount_out");
  for (const event of events) {
    const { index: i, data } = event.toJSON();
    if (i === index) return BigInt(data[field]);
  }
  return undefined;
}

async function main() {
  const net = env("NET", "mainnet");
  const d = loadDeployments(net);
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const api = await ApiPromise.create({
    provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud")),
    runtime: DRY_RUN_API_V2,
    types: TYPES,
    noInitWarn: true,
  });
  try {
    const idIn = Number(env("TOKEN_B", "222"));
    const idOut = Number(env("TOKEN_A", "1001"));
    const fee = Number(env("FEE", "3000"));
    const [addrIn, addrOut] = await Promise.all([resolveAssetAddress(api, idIn), resolveAssetAddress(api, idOut)]);
    const [tIn, tOut] = [addrIn, addrOut].map((a) => new ethers.Contract(a, ERC20, provider));
    const [decIn, decOut, symIn, symOut] = await Promise.all([tIn.decimals(), tOut.decimals(), tIn.symbol(), tOut.symbol()]);
    const amountIn = ethers.parseUnits(env("QUOTE_AMOUNT", "100"), decIn);
    console.log(`=== Quote ${ethers.formatUnits(amountIn, decIn)} ${symIn} (${idIn}) -> ${symOut} (${idOut}), fee ${fee} ===`);

    const factory = new ethers.Contract(d.uniswap.v3CoreFactory, ABI.factory, provider);
    const poolAddress = await factory.getPool(...sortTokens(addrIn, addrOut), fee);
    if (poolAddress === ethers.ZeroAddress) throw new Error("the factory has no pool for this pair and fee");
    const liquidity = await new ethers.Contract(poolAddress, ABI.pool, provider).liquidity();
    console.log(`  pool ${poolAddress}, in-range liquidity ${liquidity}`);
    if (liquidity === 0n) throw new Error("the pool has no in-range liquidity — has the keeper minted the seed yet?");

    const quoter = new ethers.Contract(d.uniswap.quoterV2, QUOTER, provider);
    const [evmOut] = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: addrIn, tokenOut: addrOut, amountIn, fee, sqrtPriceLimitX96: 0,
    });
    console.log(`  EVM QuoterV2        -> ${ethers.formatUnits(evmOut, decOut)} ${symOut}`);

    const from = env("QUOTE_FROM", TREASURY);
    const route = [{ pool: { UniswapV3: fee }, assetIn: idIn, assetOut: idOut }];
    const call = api.tx.router.sell(idIn, idOut, amountIn, 1, route);
    const origin = api.createType("QuoteOrigin", { system: { Signed: from } });
    const result = await api.call.dryRunApi.dryRunCall(origin, call, XCM_VERSION);
    if (result.isErr) throw new Error(`dry run refused: ${result.asErr.toString()}`);
    const effects = result.asOk;
    if (effects.executionResult.isErr) {
      throw new Error(`router.sell would fail: ${JSON.stringify(effects.executionResult.asErr.toHuman())}`);
    }
    const subOut = executedAmountOut(api, effects.emittedEvents);
    if (subOut === undefined) throw new Error("router.sell ran but emitted no router.Executed");
    console.log(`  Substrate router    -> ${ethers.formatUnits(subOut, decOut)} ${symOut}  (dry run from ${from})`);

    if (subOut !== evmOut) console.log("  ! the two routers disagree; both went through the same pool, so check the route");
    console.log("\n=== both routers quote this pool ===");
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => {
  console.error(`\nQuote failed: ${error.message}\n`);
  process.exit(1);
});
