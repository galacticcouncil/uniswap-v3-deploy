/**
 * 01-governance-calldata.js — build (do NOT submit) the governance calls needed
 * around the deploy. Prints call hex + preimage hash + length for a referendum.
 *
 *   node 01-governance-calldata.js whitelist        # EVMAccounts::add_contract_deployer(deployer)
 *   node 01-governance-calldata.js set-addresses    # Parameters::set_uniswap_v3_addresses(f, r, q)
 *
 * whitelist      -> origin: EVMAccounts ControllerOrigin (Root/TechCommittee per runtime)
 * set-addresses  -> origin: Root (needs the PR #1477 runtime live on-chain)
 *
 * On lark, hydration-node's scripts/uniswap-v3-lark CLI submits+votes these
 * automatically; this script is for real tracks.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { blake2AsHex } = require("@polkadot/util-crypto");
const { env, requireEnv, loadDeployments } = require("./lib");

function printCall(title, tx) {
  const hex = tx.method.toHex();
  console.log(`\n=== ${title} ===`);
  console.log(`  call:          ${tx.method.section}.${tx.method.method}`);
  console.log(`  encoded:       ${hex}`);
  console.log(`  preimage hash: ${blake2AsHex(hex)}`);
  console.log(`  length:        ${(hex.length - 2) / 2}`);
  console.log(`  submit: preimage.notePreimage(encoded), then referenda.submit`);
  console.log(`          with Lookup { hash, len } on the origin noted above.`);
}

async function main() {
  const cmd = process.argv[2];
  if (!["whitelist", "set-addresses"].includes(cmd)) {
    console.error("usage: node 01-governance-calldata.js <whitelist|set-addresses>");
    process.exit(1);
  }

  const api = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", "wss://rpc.hydradx.cloud")) });
  try {
    if (cmd === "whitelist") {
      const deployer = new ethers.Wallet(requireEnv("DEPLOYER_PK")).address;
      const already = (await api.query.evmAccounts.contractDeployer(deployer)).isSome;
      if (already) return console.log(`${deployer} already whitelisted — nothing to do`);
      printCall(`whitelist ${deployer}`, api.tx.evmAccounts.addContractDeployer(deployer));
    } else {
      if (!api.tx.parameters?.setUniswapV3Addresses) {
        throw new Error("runtime has no parameters.setUniswapV3Addresses — PR #1477 not live on this chain");
      }
      const d = loadDeployments(env("NET", "mainnet"));
      const { v3CoreFactory, swapRouter02, quoterV2 } = d.uniswap;
      if (!v3CoreFactory || !swapRouter02 || !quoterV2) throw new Error("missing addresses in deployments file");
      console.log(`  factory ${v3CoreFactory}\n  router  ${swapRouter02}\n  quoter  ${quoterV2}`);
      printCall(
        "set uniswap v3 addresses",
        api.tx.parameters.setUniswapV3Addresses(v3CoreFactory, swapRouter02, quoterV2)
      );
    }
  } finally {
    await api.disconnect();
  }
}

main().catch((e) => {
  console.error("\n  FAILED:", e.message, "\n");
  process.exit(1);
});
