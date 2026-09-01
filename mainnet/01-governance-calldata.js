/**
 * Build governance proposals without submitting them.
 *
 *   node 01-governance-calldata.js fee <pool> [feeProtocol]
 *   node 01-governance-calldata.js ema
 *   node 01-governance-calldata.js router
 *   node 01-governance-calldata.js launch [pool]
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { blake2AsHex } = require("@polkadot/util-crypto");
const { env, gasOverrides, loadDeployments, resolveAssetAddress, sortTokens, ABI } = require("./lib");

const TRACK = {
  root: { id: 0, origin: { system: "Root" } },
  economicParameters: { id: 9, origin: { Origins: "EconomicParameters" } },
};
const AAVE_MANAGER_EVM = "0xaa7e0000000000000000000000000000000aa7e0";
const EMA_SOURCE = "0x756e697377707633"; // ASCII "uniswpv3", exactly eight bytes.

const feeProtocol = (value) => {
  const fee = Number(value ?? env("FEE_PROTOCOL", "4"));
  if (!Number.isInteger(fee) || !(fee === 0 || (fee >= 4 && fee <= 10))) {
    throw new Error("feeProtocol must be 0 or an integer from 4 through 10");
  }
  return fee;
};

function printProposal(title, call, track) {
  const encoded = call.method.toHex();
  const length = (encoded.length - 2) / 2;
  console.log(`\n=== ${title} ===`);
  console.log(`  call:          ${call.method.section}.${call.method.method}`);
  console.log(`  encoded:       ${encoded}`);
  console.log(`  preimage hash: ${blake2AsHex(encoded)}`);
  console.log(`  length:        ${length}`);
  console.log(`  track:         ${track.id}`);
  console.log(`  origin:        ${JSON.stringify(track.origin)}`);
  console.log("  submit:        note this preimage, submit it on the track above, and place its decision deposit.");
}

async function pair(api) {
  const a = Number(env("TOKEN_A", "1001"));
  const b = Number(env("TOKEN_B", "222"));
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) throw new Error("TOKEN_A and TOKEN_B must be distinct asset IDs");
  return { a, b, orderedIds: [a, b].sort((x, y) => x - y) };
}

async function emaTracked(api, ids) {
  const assets = await Promise.all(ids.map((id) => api.query.assetRegistry.assets(id)));
  if (assets.every((asset) => asset.isSome && asset.unwrap().isSufficient.isTrue)) return true;

  const whitelist = await api.query.emaOracle.whitelistedAssets();
  return whitelist.toJSON().some(([source, listed]) =>
    String(source).toLowerCase() === EMA_SOURCE && Number(listed[0]) === ids[0] && Number(listed[1]) === ids[1]
  );
}

async function emaCall(api) {
  if (!api.tx.emaOracle?.addOracle) throw new Error("runtime has no emaOracle.addOracle");
  const { orderedIds } = await pair(api);
  return api.tx.emaOracle.addOracle(EMA_SOURCE, orderedIds);
}

async function feeCall(api, provider, pool, value) {
  if (!ethers.isAddress(pool)) throw new Error(`not a pool address: ${pool}`);
  const onChainManager = await api.query.dispatcher.aaveManagerAccount();
  const managerEvm = "0x" + Buffer.from(onChainManager.toU8a().slice(0, 20)).toString("hex");
  if (managerEvm.toLowerCase() !== AAVE_MANAGER_EVM) {
    throw new Error(`dispatcher Aave-manager account changed to ${managerEvm}; refuse to use the stale owner address`);
  }
  const fee = feeProtocol(value);
  const data = new ethers.Interface(ABI.pool).encodeFunctionData("setFeeProtocol", [fee, fee]);
  const gas = await gasOverrides(provider, { gasLimit: 500_000n });
  return api.tx.dispatcher.dispatchAsAaveManager(
    api.tx.evm.call(AAVE_MANAGER_EVM, pool, data, 0, gas.gasLimit, gas.gasPrice, null, null, [], [])
  );
}

async function routerCall(api) {
  if (!api.tx.parameters?.setUniswapV3Addresses) {
    throw new Error("runtime has no parameters.setUniswapV3Addresses; do not submit a router-registration proposal");
  }
  const deployment = loadDeployments(env("NET", "mainnet"));
  const { v3CoreFactory, swapRouter02, quoterV2 } = deployment.uniswap;
  return api.tx.parameters.setUniswapV3Addresses(v3CoreFactory, swapRouter02, quoterV2);
}

async function deployedPool(api, provider) {
  const deployment = loadDeployments(env("NET", "mainnet"));
  const { a, b } = await pair(api);
  const [addressA, addressB] = await Promise.all([resolveAssetAddress(api, a), resolveAssetAddress(api, b)]);
  const [token0, token1] = sortTokens(addressA, addressB);
  const pool = await new ethers.Contract(deployment.uniswap.v3CoreFactory, ABI.factory, provider).getPool(token0, token1, Number(env("FEE", "3000")));
  if (pool === ethers.ZeroAddress) throw new Error("pool does not exist; run 03-create-pool.js first");
  return pool;
}

async function launchCall(api, provider, explicitPool) {
  const calls = [];
  let requiresRoot = false;
  const { orderedIds } = await pair(api);
  if (!(await emaTracked(api, orderedIds))) {
    calls.push(await emaCall(api));
    console.log("  + EMA-oracle tracking for the launch pair");
  }

  const pool = explicitPool ?? (await deployedPool(api, provider));
  const currentProtocolFee = Number((await new ethers.Contract(pool, ABI.pool, provider).slot0()).feeProtocol);
  const wanted = feeProtocol();
  if ((currentProtocolFee & 0x0f) !== wanted || (currentProtocolFee >> 4) !== wanted) {
    calls.push(await feeCall(api, provider, pool, wanted));
    console.log(`  + setFeeProtocol(${wanted}, ${wanted}) for ${pool}`);
  }

  if (api.tx.parameters?.setUniswapV3Addresses) {
    calls.push(await routerCall(api));
    requiresRoot = true;
    console.log("  + runtime Uniswap-v3 router registration");
  } else {
    console.log("  ! runtime router-registration call absent; omitted from launch proposal");
  }
  if (!calls.length) return undefined;
  return {
    call: calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls),
    track: requiresRoot ? TRACK.root : TRACK.economicParameters,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["fee", "ema", "router", "launch"].includes(command)) {
    throw new Error("usage: node 01-governance-calldata.js <fee|ema|router|launch> [arguments]");
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud")),
    noInitWarn: true,
  });
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", "https://rpc.hydradx.cloud"));
  try {
    const version = api.runtimeVersion;
    console.log(`chain: ${version.specName} spec ${version.specVersion}`);
    if (command === "fee") {
      const pool = args[0];
      if (!pool) throw new Error("usage: fee <pool> [feeProtocol]");
      printProposal(`set protocol fee for ${pool}`, await feeCall(api, provider, pool, args[1]), TRACK.economicParameters);
    } else if (command === "ema") {
      const ids = (await pair(api)).orderedIds;
      if (await emaTracked(api, ids)) return console.log("EMA oracle already tracks this pair; no proposal needed.");
      printProposal(`track EMA oracle for assets ${ids.join("/")}`, await emaCall(api), TRACK.economicParameters);
    } else if (command === "router") {
      printProposal("register Uniswap-v3 runtime addresses", await routerCall(api), TRACK.root);
    } else {
      const result = await launchCall(api, provider, args[0]);
      if (!result) return console.log("All governance-controlled launch state already matches the configuration.");
      printProposal("launch bundle", result.call, result.track);
    }
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => {
  console.error(`\nGovernance calldata failed: ${error.message}\n`);
  process.exit(1);
});
