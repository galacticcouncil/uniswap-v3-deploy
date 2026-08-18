/**
 * 02-deploy.js — run this repo's @uniswap/deploy-v3 CLI against the configured
 * network and write a clean address handoff file.
 *
 * Same shape as zombienet/deploy.js, but env-driven and resumable: state is
 * kept per network, so a crashed run picks up at the failed step.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const { env, requireEnv, assetToEvmAddress, saveJson } = require("./lib");

const REPO = path.join(__dirname, "..");
const WETH9 = assetToEvmAddress(20); // router-only field; never called on ERC-20 paths

function main() {
  const net = env("NET", "mainnet");
  const rpc = env("EVM_RPC_URL", "https://rpc.hydradx.cloud");
  const pk = requireEnv("DEPLOYER_PK");
  const deployer = new ethers.Wallet(pk).address;
  const owner = env("OWNER_ADDRESS", deployer);
  const state = path.join(__dirname, "deployments", `${net}-state.json`);
  fs.mkdirSync(path.dirname(state), { recursive: true });

  const cli = path.join(REPO, "dist", "index.js");
  if (!fs.existsSync(cli)) {
    console.log("=== Building deploy-v3 CLI (yarn build) ===");
    execFileSync("yarn", ["build"], {
      cwd: REPO,
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: "--openssl-legacy-provider" },
    });
  }

  console.log(`=== Deploying Uniswap v3 -> ${rpc} (${net}) ===`);
  console.log(`  deployer ${deployer}`);
  console.log(`  owner    ${owner}${owner === deployer ? "  (transfer later via 04-owner-ops.js transfer-owner)" : ""}`);
  execFileSync(
    "node",
    [cli, "-pk", pk, "-j", rpc, "-w9", WETH9, "-ncl", "WETH", "-o", owner, "-s", state, "-c", env("CONFIRMATIONS", "2")],
    { stdio: "inherit" }
  );

  const s = JSON.parse(fs.readFileSync(state, "utf8"));
  const out = {
    network: { name: net, evmRpc: rpc, substrateWs: env("WS_URL", "wss://rpc.hydradx.cloud") },
    deployer,
    owner,
    tokens: {
      weth: { assetId: 20, address: WETH9, role: "gas" },
      tokenA: { assetId: Number(env("TOKEN_A", "1001")), address: assetToEvmAddress(Number(env("TOKEN_A", "1001"))) },
      tokenB: { assetId: Number(env("TOKEN_B", "222")), address: assetToEvmAddress(Number(env("TOKEN_B", "222"))) },
    },
    uniswap: {
      v3CoreFactory: s.v3CoreFactoryAddress,
      multicall2: s.multicall2Address,
      proxyAdmin: s.proxyAdminAddress,
      tickLens: s.tickLensAddress,
      quoterV2: s.quoterV2Address,
      nftDescriptorLibrary: s.nftDescriptorLibraryAddressV1_3_0,
      nonfungibleTokenPositionDescriptor: s.nonfungibleTokenPositionDescriptorAddressV1_3_0,
      descriptorProxy: s.descriptorProxyAddress,
      nonfungiblePositionManager: s.nonfungibleTokenPositionManagerAddress,
      v3Migrator: s.v3MigratorAddress,
      v3Staker: s.v3StakerAddress,
      swapRouter02: s.swapRouter02,
      weth9: WETH9,
    },
  };
  const missing = Object.entries(out.uniswap).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing addresses: ${missing.join(", ")}`);
  const p = saveJson(path.join("deployments", `${net}.json`), out);
  console.log(`  Wrote ${p}`);
}

try {
  main();
} catch (e) {
  console.error("\n  Deploy FAILED:", e.message, "\n");
  process.exit(1);
}
