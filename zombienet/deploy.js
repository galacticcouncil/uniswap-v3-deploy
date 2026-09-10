/**
 * deploy.js  —  deploy the full Uniswap v3 stack via this repo's @uniswap/deploy-v3
 * CLI, then write a clean address handoff file for the Gamma phase.
 *
 * Run directly (`node deploy.js`) or import { deploy }.
 * Env: DEPLOYER_PK, DEPLOYER_EVM, EVM_RPC_URL, WETH9_ADDRESS.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const DEPLOY_DIR = path.join(__dirname, "deployments");
const STATE = path.join(DEPLOY_DIR, "state.json");
const OUT = path.join(DEPLOY_DIR, "zombienet.json");

// The deploy-v3 CLI requires the 0x prefix (regex /^0x[a-f0-9]{64}$/).
const PRIVKEY = process.env.DEPLOYER_PK || "0x653a29ac0c93de0e9f7d7ea2d60338e68f407b18d16d6ff84db996076424f8fa";
const OWNER = process.env.DEPLOYER_EVM || "0xC19A2970A13ac19898c47d59Cbd0278D428EBC7c";
const RPC = process.env.EVM_RPC_URL || "http://127.0.0.1:9999";
// Router's WETH9 = the WETH asset-20 precompile (never called on KSM/KUSD paths).
const WETH9 = process.env.WETH9_ADDRESS || "0x0000000000000000000000000000000100000014";

function extractAddresses() {
  if (!fs.existsSync(STATE)) throw new Error(`${STATE} not found`);
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const out = {
    network: { name: "zombienet-local", evmRpc: RPC, substrateWs: "ws://127.0.0.1:9999", chainId: 2222222, paraId: 2032 },
    deployer: { evm: OWNER, substrate: "5DdcCSDqrt3ThGfhqr63psaauSd1HZPpXEmWcNdiggzkXehL" },
    // Asset ERC-20 precompiles: 0x..01 ++ assetId (big-endian, last 4 bytes).
    tokens: {
      weth: { assetId: 20, address: "0x0000000000000000000000000000000100000014", role: "gas" },
      ksm: { assetId: 1, address: "0x0000000000000000000000000000000100000001", role: "token0" },
      kusd: { assetId: 2, address: "0x0000000000000000000000000000000100000002", role: "token1" },
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
      // weth9 is a deploy *input* (the asset-20 precompile), not in state.json.
      weth9: s.weth9Address || WETH9,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`  Wrote ${OUT}`);
  for (const [k, v] of Object.entries(out.uniswap)) console.log(`    ${k.padEnd(34)} ${v || "(missing)"}`);
  const missing = Object.entries(out.uniswap).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing addresses: ${missing.join(", ")}`);
}

function deploy() {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });

  // Build the CLI bundle once. The legacy OpenSSL provider is required because
  // the bundled (old) webpack uses MD4, unsupported on OpenSSL 3 / Node 17+.
  const cli = path.join(REPO, "dist", "index.js");
  if (!fs.existsSync(cli)) {
    console.log("=== Building deploy-v3 CLI (yarn build) ===");
    execFileSync("yarn", ["build"], {
      cwd: REPO,
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: "--openssl-legacy-provider" },
    });
  }

  console.log(`=== Deploying Uniswap v3 -> ${RPC} ===`);
  // -c 1: wait for inclusion (parachain auto-mines ~6-12s) so addresses resolve.
  execFileSync(
    "node",
    [cli, "-pk", PRIVKEY, "-j", RPC, "-w9", WETH9, "-ncl", "WETH", "-o", OWNER, "-s", STATE, "-c", "1"],
    { stdio: "inherit" }
  );

  console.log("=== Extracting addresses ===");
  extractAddresses();
}

if (require.main === module) {
  try {
    deploy();
  } catch (e) {
    console.error("\n  Deploy FAILED:", e.message, "\n");
    process.exit(1);
  }
}

module.exports = { deploy, extractAddresses };
