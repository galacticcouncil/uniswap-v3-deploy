/**
 * Deploy UniswapV3FeeSetter once, check it, and record it as `uniswap.feeSetter`.
 * The bytecode comes from artifacts/UniswapV3FeeSetter.json, built in money-market.
 *
 *   ENV_FILE=.env.pools node 06-deploy-fee-setter.js
 *
 * It never hands the factory over: that is the `handover` referendum.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { env, requireEnv, gasOverrides, loadDeployments, saveJson } = require("./lib");

const ARTIFACT = path.join(__dirname, "artifacts", "UniswapV3FeeSetter.json");
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// From runtime 443 an unlisted key's CREATE fails as a Substrate extrinsic and
// produces no EVM receipt, so waiting for one would hang. Refuse up front.
async function assertAllowlisted(api, address) {
  if (!api.query.evmAccounts?.contractDeployer) return;
  if ((await api.query.evmAccounts.contractDeployer(address)).isNone) {
    throw new Error(`${address} is not in EVMAccounts::ContractDeployer; it cannot deploy`);
  }
}

async function deploy(wallet, artifact) {
  const confirmations = Number(env("CONFIRMATIONS", "2"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(await gasOverrides(wallet.provider));
  const tx = contract.deploymentTransaction();
  console.log(`  tx ${tx.hash}`);
  const receipt = await tx.wait(confirmations, 15 * 60_000);
  if (!receipt || receipt.status !== 1) throw new Error(`deploy reverted or timed out (${tx.hash})`);
  return receipt.contractAddress;
}

// The code must be exactly the committed build, and its constants must match the record.
async function checkDeployed(provider, address, artifact, deployment) {
  const code = await provider.getCode(address);
  if (code !== artifact.deployedBytecode) throw new Error(`code at ${address} is not the committed build`);
  const setter = new ethers.Contract(address, artifact.abi, provider);
  const [factory, manager, feeProtocol] = await Promise.all([setter.FACTORY(), setter.MANAGER(), setter.FEE_PROTOCOL()]);
  if (!same(factory, deployment.uniswap.v3CoreFactory)) throw new Error(`FACTORY() is ${factory}, record says ${deployment.uniswap.v3CoreFactory}`);
  if (!same(manager, deployment.owner)) throw new Error(`MANAGER() is ${manager}, record owner is ${deployment.owner}`);
  if (Number(feeProtocol) !== 4) throw new Error(`FEE_PROTOCOL() is ${feeProtocol}, expected 4`);
  console.log(`  code matches the build; FACTORY ${factory}, MANAGER ${manager}, FEE_PROTOCOL ${feeProtocol}`);
}

async function main() {
  const net = env("NET", "mainnet");
  const deployment = loadDeployments(net);
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", deployment.network.evmRpc));
  console.log(`=== UniswapV3FeeSetter on ${net} ===`);

  const recorded = deployment.uniswap.feeSetter;
  if (recorded) {
    if ((await provider.getCode(recorded)) === "0x") throw new Error(`recorded feeSetter ${recorded} has no code on this chain`);
    return console.log(`  already deployed at ${recorded}; nothing to do`);
  }
  const chainId = (await provider.getNetwork()).chainId.toString();
  if (chainId !== deployment.network.chainId) throw new Error(`chain ID ${chainId}; record is for ${deployment.network.chainId}`);

  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const api = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", deployment.network.substrateWs)), noInitWarn: true });
  try {
    await assertAllowlisted(api, wallet.address);
  } finally {
    await api.disconnect();
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  console.log(`  deployer ${wallet.address}, build ${artifact.source}`);
  const address = await deploy(wallet, artifact);
  await checkDeployed(provider, address, artifact, deployment);

  deployment.uniswap.feeSetter = address;
  console.log(`  feeSetter ${address}; wrote ${saveJson(path.join("deployments", `${net}.json`), deployment)}`);
}

main().catch((error) => {
  console.error(`\n  fee-setter deploy FAILED: ${error.message}\n`);
  process.exit(1);
});
