/**
 * chainspec.js  —  build a raw `local` chain spec wired for an EVM deployment.
 *
 *   1. export the plain `local` spec from the hydradx binary
 *   2. patch genesis: register WETH (gas), fund the deployer (WETH/KSM/KUSD/HDX),
 *      big native balances for Alice/Bob (instant referendum), TC, para id 2032
 *   3. build the raw spec
 *   4. inject two raw storage keys with no plain-spec representation:
 *        Parameters::IsTestnet = true        (1-block governance)
 *        EVMAccounts::ContractDeployer[addr] (permissioned contract creation)
 *
 * Output: chainspec-raw.json (loaded by zombienet.json).
 * Run directly (`node chainspec.js`) or import { build }.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { xxhashAsHex, blake2AsHex } = require("@polkadot/util-crypto");
const { hexToU8a } = require("@polkadot/util");

// hydration-node is a sibling of this repo; override with HYDRADX=/abs/path.
const HYDRADX = process.env.HYDRADX || path.join(__dirname, "../../hydration-node/target/release/hydradx");
const OUT = path.join(__dirname, "chainspec-raw.json");
const PLAIN = path.join(__dirname, "chainspec-plain.json");

// Deployer EVM 0xC19A2970A13ac19898c47d59Cbd0278D428EBC7c (Charlie's EVM key).
// An unbound EVM address maps to this "truncated" substrate account, where its
// balances live.
const DEPLOYER_EVM = "0xC19A2970A13ac19898c47d59Cbd0278D428EBC7c";
const DEPLOYER_SUBSTRATE = "5DdcCSDqrt3ThGfhqr63psaauSd1HZPpXEmWcNdiggzkXehL";
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";

const WETH = 20; // gas
const KSM = 1; // pool token0
const KUSD = 2; // pool token1

// Raw-unit amounts (spliced unquoted to dodge JS scientific-notation).
const NATIVE = "1000000000000000000000"; // 1e21 governance weight
const DEPLOYER_NATIVE = "1000000000000000000"; // 1e18 existential/misc
const WETH_AMT = "100000000000000000000000"; // 1e23 gas
const TOKEN_AMT = "1000000000000000000000000"; // 1e24 pool inventory

function patchedPlain(plainText) {
  const spec = JSON.parse(plainText);
  const g = spec.genesis.runtimeGenesis.patch;

  g.assetRegistry = g.assetRegistry || { registeredAssets: [] };
  if (!g.assetRegistry.registeredAssets.some((a) => a[0] === WETH)) {
    g.assetRegistry.registeredAssets.push([
      WETH,
      [69, 116, 104, 101, 114, 101, 117, 109], // 'Ethereum'
      1000000000000,
      [87, 69, 84, 72], // 'WETH'
      18,
      null,
      true,
    ]);
  }

  g.balances = g.balances || { balances: [] };
  const setNative = (addr, amt) => {
    const i = g.balances.balances.findIndex((b) => b[0] === addr);
    if (i >= 0) g.balances.balances[i] = [addr, amt];
    else g.balances.balances.push([addr, amt]);
  };
  setNative(ALICE, "__NATIVE__");
  setNative(BOB, "__NATIVE__");
  setNative(DEPLOYER_SUBSTRATE, "__DEPLOYER_NATIVE__");

  g.tokens = g.tokens || { balances: [] };
  const setToken = (addr, id, ph) => {
    const i = g.tokens.balances.findIndex((b) => b[0] === addr && b[1] === id);
    if (i >= 0) g.tokens.balances[i] = [addr, id, ph];
    else g.tokens.balances.push([addr, id, ph]);
  };
  setToken(DEPLOYER_SUBSTRATE, WETH, "__WETH__");
  setToken(DEPLOYER_SUBSTRATE, KSM, "__TOKEN__");
  setToken(DEPLOYER_SUBSTRATE, KUSD, "__TOKEN__");
  setToken(ALICE, WETH, "__WETH__");
  setToken(BOB, WETH, "__WETH__");

  g.technicalCommittee = g.technicalCommittee || {};
  g.technicalCommittee.members = [ALICE, BOB, CHARLIE];
  g.parachainInfo = { parachainId: 2032 };
  spec.para_id = 2032;

  return JSON.stringify(spec, null, 2)
    .replace(/"__NATIVE__"/g, NATIVE)
    .replace(/"__DEPLOYER_NATIVE__"/g, DEPLOYER_NATIVE)
    .replace(/"__WETH__"/g, WETH_AMT)
    .replace(/"__TOKEN__"/g, TOKEN_AMT);
}

function buildSpec(args) {
  return execFileSync(HYDRADX, args, { maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function build() {
  if (!fs.existsSync(HYDRADX)) {
    throw new Error(`hydradx binary not found at ${HYDRADX}\n  build it: (cd ../hydration-node && cargo build --release)`);
  }
  console.log("=== Building local EVM-ready chain spec ===");

  console.log("[1/4] Export plain spec (--chain local)...");
  const plain = buildSpec(["build-spec", "--chain", "local", "--disable-default-bootnode"]);

  console.log("[2/4] Patch genesis (WETH + funded deployer + TC + para id)...");
  fs.writeFileSync(PLAIN, patchedPlain(plain));

  console.log("[3/4] Build raw spec...");
  const raw = buildSpec(["build-spec", "--chain", PLAIN, "--raw", "--disable-default-bootnode"]);
  const spec = JSON.parse(raw);

  console.log("[4/4] Inject raw storage (IsTestnet + ContractDeployer)...");
  const top = spec.genesis.raw.top;
  top[xxhashAsHex("Parameters", 128) + xxhashAsHex("IsTestnet", 128).slice(2)] = "0x01";
  const a = hexToU8a(DEPLOYER_EVM);
  top[
    xxhashAsHex("EVMAccounts", 128) +
      xxhashAsHex("ContractDeployer", 128).slice(2) +
      blake2AsHex(a, 128).slice(2) +
      Buffer.from(a).toString("hex")
  ] = "0x";
  fs.writeFileSync(OUT, JSON.stringify(spec, null, 2));

  fs.rmSync(PLAIN, { force: true });
  console.log(`  IsTestnet = true; ContractDeployer whitelisted ${DEPLOYER_EVM}`);
  console.log(`=== Done -> ${OUT} ===`);
}

if (require.main === module) {
  try {
    build();
  } catch (e) {
    console.error("\n  chainspec build FAILED:", e.message, "\n");
    process.exit(1);
  }
}

module.exports = { build, DEPLOYER_EVM, DEPLOYER_SUBSTRATE };
