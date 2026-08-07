/**
 * 00-preflight.js — read-only checks before touching mainnet:
 *   EVM RPC + chain id, deployer address, ContractDeployer whitelist,
 *   WETH gas balance, asset registry entries + precompile decimals,
 *   parameters.uniswapV3* storage (post PR #1477), DIA feed freshness.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { env, requireEnv, assetToEvmAddress, ABI } = require("./lib");

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

async function main() {
  const evmRpc = env("EVM_RPC_URL", "https://rpc.hydradx.cloud");
  const wsUrl = env("WS_URL", "wss://rpc.hydradx.cloud");
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);

  console.log(`=== Preflight (${env("NET", "mainnet")}) ===`);
  const net = await provider.getNetwork();
  ok(`EVM RPC ${evmRpc} — chainId ${net.chainId}, block ${await provider.getBlockNumber()}`);
  console.log(`  deployer ${wallet.address}`);

  const gas = await provider.getBalance(wallet.address);
  gas > 0n
    ? ok(`WETH gas balance ${ethers.formatEther(gas)}`)
    : warn(`WETH gas balance is 0 — fund asset 20 before deploying`);

  for (const [label, id] of [
    ["TOKEN_A", Number(env("TOKEN_A", "5"))],
    ["TOKEN_B", Number(env("TOKEN_B", "222"))],
  ]) {
    const addr = assetToEvmAddress(id);
    try {
      const erc = new ethers.Contract(addr, ABI.erc20, provider);
      const [sym, dec] = await Promise.all([erc.symbol(), erc.decimals()]);
      ok(`${label} asset ${id} -> ${addr} (${sym}, ${dec} decimals)`);
    } catch {
      warn(`${label} asset ${id} -> ${addr}: precompile not readable`);
    }
  }

  const dia = env("DIA_FEED");
  if (dia) {
    try {
      const feed = new ethers.Contract(dia, ABI.dia, provider);
      const [value, ts] = await feed.getValue(env("DIA_KEY", "DOT/USD"));
      const age = Math.floor(Date.now() / 1000) - Number(ts);
      const stale = age > Number(env("STALE_SECONDS", "3600"));
      (stale ? warn : ok)(
        `DIA ${env("DIA_KEY", "DOT/USD")} = ${Number(value) / 1e8} (age ${age}s${stale ? " — STALE" : ""})`
      );
    } catch (e) {
      warn(`DIA feed ${dia} unreadable: ${e.message}`);
    }
  } else {
    warn("DIA_FEED not set — 03-create-pool.js will need PRICE");
  }

  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
  try {
    ok(`substrate WS ${wsUrl} — ${await api.rpc.system.chain()}`);
    const whitelisted = (await api.query.evmAccounts.contractDeployer(wallet.address)).isSome;
    whitelisted
      ? ok("deployer whitelisted in EVMAccounts::ContractDeployer")
      : warn("deployer NOT whitelisted — run 01-governance-calldata.js whitelist");

    if (api.query.parameters?.uniswapV3Factory) {
      const f = await api.query.parameters.uniswapV3Factory();
      f.isSome
        ? ok(`parameters.uniswapV3Factory = ${f.unwrap().toHex()}`)
        : warn("parameters.uniswapV3Factory unset — router venue not configured yet");
    } else {
      warn("runtime has no parameters.uniswapV3* storage — PR #1477 not live on this chain");
    }
  } finally {
    await api.disconnect();
  }
  console.log("=== Preflight done ===");
}

main().catch((e) => {
  console.error("\n  Preflight FAILED:", e.message, "\n");
  process.exit(1);
});
