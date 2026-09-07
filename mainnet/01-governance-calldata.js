/**
 * Build governance proposals without submitting them.
 *
 *   node 01-governance-calldata.js deployer [evmAddress]
 *   node 01-governance-calldata.js fee <pool> [feeProtocol]
 *   node 01-governance-calldata.js ema
 *   node 01-governance-calldata.js router
 *   node 01-governance-calldata.js launch [pool]
 *
 * Every proposal prints on track 0 (Root). That is not a cautious default, it
 * is the only track that can carry the launch:
 * `pallet_parameters::set_uniswap_v3_addresses` is `ensure_root(origin)` with
 * no configurable origin type, so router registration is Root or nothing.
 *
 * The protocol-fee and EMA calls do individually accept the narrower
 * EconomicParameters track, and earlier revisions of this script split them out
 * for that reason. Bundling them under Root instead costs no additional
 * privilege — the bundle needs Root regardless — and saves a second referendum,
 * a second decision deposit and a second enactment window to reconcile.
 *
 * The Root-equivalent fast path is a Technical Committee whitelist of the
 * preimage hash followed by a track-1 (`whitelisted_caller`) referendum, which
 * dispatches the same call with Root. The TC is not itself an origin that can
 * make these calls.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { blake2AsHex } = require("@polkadot/util-crypto");
const { env, gasOverrides, loadDeployments, resolveAssetAddress, sortTokens, ABI } = require("./lib");

const ROOT = { id: 0, origin: { system: "Root" } };
const AAVE_MANAGER_EVM = "0xaa7e0000000000000000000000000000000aa7e0";
const EMA_SOURCE = "0x756e697377707633"; // ASCII "uniswpv3", exactly eight bytes.

const feeProtocol = (value) => {
  const fee = Number(value ?? env("FEE_PROTOCOL", "4"));
  if (!Number.isInteger(fee) || !(fee === 0 || (fee >= 4 && fee <= 10))) {
    throw new Error("feeProtocol must be 0 or an integer from 4 through 10");
  }
  return fee;
};

function printProposal(title, call) {
  const encoded = call.method.toHex();
  const length = (encoded.length - 2) / 2;
  console.log(`\n=== ${title} ===`);
  console.log(`  call:          ${call.method.section}.${call.method.method}`);
  console.log(`  encoded:       ${encoded}`);
  console.log(`  preimage hash: ${blake2AsHex(encoded)}`);
  console.log(`  length:        ${length}`);
  console.log(`  track:         ${ROOT.id} (root)`);
  console.log(`  origin:        ${JSON.stringify(ROOT.origin)}`);
  console.log("  submit:        note this preimage, submit it on track 0, and place its decision deposit.");
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

/**
 * List the deploy key on `EVMAccounts::ContractDeployer`.
 *
 * This has to be enacted BEFORE 02-deploy.js runs, not bundled with the launch
 * proposal. From runtime spec 443 `pallet_evm`'s `CreateOriginFilter` is
 * `EnsureWhitelistedDeployer`, so an unlisted key's signed CREATE fails with
 * `CreateOriginNotAllowed` — on spec 440 and earlier the filter was `()` and
 * the list only gated the RPC simulation route.
 */
async function deployerCall(api, address) {
  if (!api.tx.evmAccounts?.addContractDeployer) {
    throw new Error("runtime has no evmAccounts.addContractDeployer");
  }
  if (!ethers.isAddress(address || "")) throw new Error(`not an EVM address: ${address}`);
  return api.tx.evmAccounts.addContractDeployer(ethers.getAddress(address));
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
    console.log("  + runtime Uniswap-v3 router registration");
  } else {
    console.log("  ! runtime router-registration call absent; omitted from launch proposal");
  }
  if (!calls.length) return undefined;
  return calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["deployer", "fee", "ema", "router", "launch"].includes(command)) {
    throw new Error("usage: node 01-governance-calldata.js <deployer|fee|ema|router|launch> [arguments]");
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud")),
    noInitWarn: true,
  });
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", "https://rpc.hydradx.cloud"));
  try {
    const version = api.runtimeVersion;
    console.log(`chain: ${version.specName} spec ${version.specVersion}`);
    if (command === "deployer") {
      // Default to the configured deploy key so the listed address cannot drift
      // from the one that will actually send the CREATE transactions.
      const address = args[0] ?? (env("DEPLOYER_PK") ? new ethers.Wallet(env("DEPLOYER_PK")).address : undefined);
      if (!address) throw new Error("usage: deployer <evmAddress> (or set DEPLOYER_PK)");
      if (!api.query.evmAccounts?.contractDeployer) throw new Error("runtime has no evmAccounts.contractDeployer");
      const listed = await api.query.evmAccounts.contractDeployer(address);
      if (listed.isSome) return console.log(`${address} is already an allowed contract deployer; no proposal needed.`);
      printProposal(`allow ${address} to deploy contracts`, await deployerCall(api, address));
      console.log("  order:         this must be ENACTED BEFORE 02-deploy.js runs.");
    } else if (command === "fee") {
      const pool = args[0];
      if (!pool) throw new Error("usage: fee <pool> [feeProtocol]");
      printProposal(`set protocol fee for ${pool}`, await feeCall(api, provider, pool, args[1]));
    } else if (command === "ema") {
      const ids = (await pair(api)).orderedIds;
      if (await emaTracked(api, ids)) return console.log("EMA oracle already tracks this pair; no proposal needed.");
      printProposal(`track EMA oracle for assets ${ids.join("/")}`, await emaCall(api));
    } else if (command === "router") {
      printProposal("register Uniswap-v3 runtime addresses", await routerCall(api));
    } else {
      const call = await launchCall(api, provider, args[0]);
      if (!call) return console.log("All governance-controlled launch state already matches the configuration.");
      printProposal("launch bundle", call);
    }
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => {
  console.error(`\nGovernance calldata failed: ${error.message}\n`);
  process.exit(1);
});
