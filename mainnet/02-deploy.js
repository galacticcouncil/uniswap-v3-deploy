/**
 * 02-deploy.js — run this repo's @uniswap/deploy-v3 CLI against the configured
 * network and write a clean address handoff file.
 *
 * Same shape as zombienet/deploy.js, but env-driven and resumable. It records
 * the target chain ID alongside the address sheet and refuses stale state.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const { env, requireEnv, assetToEvmAddress, gasOverrides, saveJson } = require("./lib");

const REPO = path.join(__dirname, "..");
const WETH9 = assetToEvmAddress(20); // router-only field; never called on ERC-20 paths

// Networks where the deploy key must NOT end up owning the factory.
const PRODUCTION_NETS = ["mainnet"];

/**
 * Resolve the post-deploy owner of the factory and ProxyAdmin.
 *
 * `owner` is an EVM address, so governance cannot merely authorise the call — it
 * has to BE that address. Hydration's EnsureAddressTruncated lets a Substrate
 * account call `evm.call` as the EVM address matching its first 20 bytes, which
 * is why the dispatch accounts have hand-picked prefixes:
 *
 *   0xaa7e…aa7e0  -> dispatcher.dispatchAsAaveManager (Root | EconomicParameters)
 *   0x6d6f646c…   -> dispatcher.dispatchAsTreasury    (Root | Treasurer)
 *
 * Getting this wrong is not loud. The dispatcher can return Ok while the inner
 * evm.call reverts, so an outer governance action may report success while
 * changing nothing. Fail here instead, where it throws.
 */
function resolveOwner(net, deployer) {
  const configured = env("OWNER_ADDRESS");
  const isProd = PRODUCTION_NETS.includes(net);
  const allowDeployer = env("ALLOW_DEPLOYER_OWNER", "false") === "true";

  if (configured) {
    if (!ethers.isAddress(configured)) throw new Error(`OWNER_ADDRESS is not an address: ${configured}`);
    if (configured.toLowerCase() !== deployer.toLowerCase()) return ethers.getAddress(configured);
  }

  const why = configured ? "OWNER_ADDRESS equals the deployer" : "OWNER_ADDRESS is unset";
  if (isProd && !allowDeployer) {
    throw new Error(
      `${why} — the deploy key would own the factory and ProxyAdmin on ${net}. ` +
        `Set OWNER_ADDRESS to a governance EVM address ` +
        `(0xaa7e0000000000000000000000000000000aa7e0 = dispatchAsAaveManager), ` +
        `or set ALLOW_DEPLOYER_OWNER=true if this really is a throwaway network.`
    );
  }
  const reason = isProd ? "ALLOW_DEPLOYER_OWNER=true overrides the production guard" : `${net} is not a production net`;
  console.log(`  ! ${why} — deploy key will own factory + ProxyAdmin (${reason})`);
  return deployer;
}

async function main() {
  const net = env("NET", "mainnet");
  const rpc = env("EVM_RPC_URL", "https://rpc.hydradx.cloud");
  const pk = requireEnv("DEPLOYER_PK");
  const deployer = new ethers.Wallet(pk).address;
  const owner = resolveOwner(net, deployer);
  const provider = new ethers.JsonRpcProvider(rpc);
  const state = path.join(__dirname, "deployments", `${net}-state.json`);
  fs.mkdirSync(path.dirname(state), { recursive: true });

  // The upstream migration state only stores addresses. Before it is resumed,
  // prove that every saved address has code on the selected chain; otherwise a
  // stale state could skip ownership-transfer or deployment steps.
  if (fs.existsSync(state)) {
    const recorded = JSON.parse(fs.readFileSync(state, "utf8"));
    const addresses = Object.entries(recorded).filter(([, v]) => typeof v === "string" && ethers.isAddress(v));
    if (addresses.length) {
      console.log(`  resume state found (${addresses.length} addresses) — validating against ${rpc}`);
      const missing = [];
      for (const [key, addr] of addresses) {
        const code = await provider.getCode(addr);
        if (!code || code === "0x") missing.push(`${key} ${addr}`);
      }
      if (missing.length) {
        throw new Error(
          `resume state ${state} does not match this chain — no code at:\n    ` +
            missing.join("\n    ") +
            `\n  Refusing to resume a state file from another chain. ` +
            `Remove ${state} only after confirming this is a fresh deployment.`
        );
      }
      console.log(`  resume state validated — all recorded contracts exist on chain`);
    }
  }

  const cli = path.join(REPO, "dist", "index.js");
  console.log("=== Building deploy-v3 CLI from this checkout ===");
  execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });

  // Hydration's RPC simulation path rejects an unlisted deployer, but an
  // actual signed CREATE is accepted by the runtime. Supplying a fixed gas
  // limit avoids `eth_estimateGas`, so the deployment neither depends on that
  // RPC-only allowlist nor on an estimate that can under-shoot on this chain.
  const overrides = await gasOverrides(provider);
  const gasPriceWei = overrides.gasPrice.toString();
  const gasLimit = overrides.gasLimit.toString();

  console.log(`=== Deploying Uniswap v3 -> ${rpc} (${net}) ===`);
  console.log(`  deployer ${deployer}`);
  console.log(
    `  owner    ${owner}${owner === deployer ? "  (DEPLOY KEY — testnet only)" : "  (governance; CLI transfers at the end of the run)"}`
  );
  console.log(`  gas      ${gasPriceWei} wei, limit ${gasLimit}`);
  execFileSync(
    "node",
    [
      cli,
      "-pk",
      pk,
      "-j",
      rpc,
      "-w9",
      WETH9,
      "-ncl",
      "WETH",
      "-o",
      owner,
      "-s",
      state,
      "-c",
      env("CONFIRMATIONS", "2"),
      "--gas-price-wei",
      gasPriceWei,
      "--gas-limit",
      gasLimit,
    ],
    { stdio: "inherit" }
  );

  const s = JSON.parse(fs.readFileSync(state, "utf8"));
  const out = {
    network: {
      name: net,
      chainId: (await provider.getNetwork()).chainId.toString(),
      evmRpc: rpc,
      substrateWs: env("WS_URL", "wss://rpc.hydradx.cloud"),
    },
    deployer,
    owner,
    tokens: {
      weth: { assetId: 20, address: WETH9, role: "gas" },
      // Recorded as the ALIAS. For an Erc20-kind asset the runtime uses the
      // registered contract instead (see lib.js resolveAssetAddress), so treat
      // these as identifiers, not as the addresses a pool is built on —
      // 03-create-pool.js resolves those from the registry.
      tokenA: { assetId: Number(env("TOKEN_A", "1001")), alias: assetToEvmAddress(Number(env("TOKEN_A", "1001"))) },
      tokenB: { assetId: Number(env("TOKEN_B", "222")), alias: assetToEvmAddress(Number(env("TOKEN_B", "222"))) },
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

main().catch((e) => {
  console.error("\n  Deploy FAILED:", e.message, "\n");
  process.exit(1);
});
