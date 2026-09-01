/**
 * Read-only launch gate. It validates the target, key, assets, price source
 * and pool configuration before any transaction is sent.
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const {
  env,
  requireEnv,
  parsePriceToE18,
  readFeedE18,
  assetToEvmAddress,
  resolveAssetAddress,
  ABI,
} = require("./lib");

let failures = 0;
const pass = (message) => console.log(`  ✓ ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`  ✗ ${message}`);
};
const note = (message) => console.log(`  ! ${message}`);

const numberIn = (name, min, max) => {
  const value = Number(env(name));
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}], got ${env(name)}`);
    return undefined;
  }
  pass(`${name}=${value}`);
  return value;
};

async function checkAssetPair(api, provider) {
  const ids = [Number(env("TOKEN_A", "1001")), Number(env("TOKEN_B", "222"))];
  if (!ids.every(Number.isInteger) || ids[0] === ids[1]) {
    fail("TOKEN_A and TOKEN_B must be two distinct integer asset IDs");
    return;
  }

  const assets = [];
  for (const [label, id] of [["TOKEN_A", ids[0]], ["TOKEN_B", ids[1]]]) {
    try {
      const address = await resolveAssetAddress(api, id);
      const token = new ethers.Contract(address, ABI.erc20, provider);
      const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
      const alias = assetToEvmAddress(id);
      pass(`${label} asset ${id}: ${symbol} (${decimals} decimals) at ${address}`);
      if (address.toLowerCase() !== alias.toLowerCase()) {
        note(`${label} is an Erc20-kind asset; its alias ${alias} is not the pool token`);
      }
      const registry = await api.query.assetRegistry.assets(id);
      assets.push({ id, address, sufficient: registry.isSome && registry.unwrap().isSufficient.isTrue });
    } catch (error) {
      fail(`${label} asset ${id} is not usable: ${error.message}`);
    }
  }
  if (assets.length !== 2) return;

  const [token0, token1] = [...assets].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  pass(`pool order: token0 = asset ${token0.id}, token1 = asset ${token1.id}`);

  const expected = [env("EXPECT_TOKEN0"), env("EXPECT_TOKEN1")];
  if (env("NET", "mainnet") === "mainnet" && (!expected[0] || !expected[1])) {
    fail("EXPECT_TOKEN0 and EXPECT_TOKEN1 are required on mainnet");
  } else if (expected[0] || expected[1]) {
    Number(expected[0]) === token0.id && Number(expected[1]) === token1.id
      ? pass("expected token ordering matches the registry")
      : fail(`expected token order ${expected.join("/")} disagrees with registry ${token0.id}/${token1.id}`);
  }

  if (assets.every((asset) => asset.sufficient)) {
    pass("pair is automatically tracked by the EMA oracle");
  } else {
    note("pair needs an EMA-oracle governance entry; `npm run governance -- ema` will print it");
  }
}

async function checkPrice(provider) {
  const staleSeconds = numberIn("STALE_SECONDS", 1, 7 * 24 * 60 * 60);
  const manual = env("PRICE");
  if (manual) {
    try {
      parsePriceToE18(manual);
      pass(`manual PRICE=${manual} is a valid decimal`);
    } catch (error) {
      fail(error.message);
    }
  }

  const feedA = env("PRICE_FEED_A");
  if (!feedA && !manual) {
    fail("set PRICE_FEED_A and/or PRICE for the irreversible pool initialization");
    return;
  }
  for (const key of ["PRICE_FEED_A", "PRICE_FEED_B"]) {
    const address = env(key);
    if (!address) continue;
    if (!ethers.isAddress(address)) {
      fail(`${key} is not an address: ${address}`);
      continue;
    }
    try {
      const feed = new ethers.Contract(address, ABI.aggregatorV3, provider);
      const [description, reading] = await Promise.all([feed.description(), readFeedE18(ethers, address, provider, staleSeconds)]);
      pass(`${key} ${description}: ${ethers.formatUnits(reading.priceE18, 18)} USD (age ${reading.age}s)`);
    } catch (error) {
      fail(`${key} cannot supply a fresh AggregatorV3 reading: ${error.message}`);
    }
  }
}

async function main() {
  const netName = env("NET", "mainnet");
  const evmRpc = env("EVM_RPC_URL", "https://rpc.hydradx.cloud");
  const wsUrl = env("WS_URL", "wss://rpc.hydradx.cloud");
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const deployer = new ethers.Wallet(requireEnv("DEPLOYER_PK"));

  console.log(`=== Uniswap v3 preflight: ${netName} ===`);
  const network = await provider.getNetwork();
  const expectedChainId = env("CHAIN_ID", netName === "mainnet" ? "222222" : undefined);
  if (expectedChainId && network.chainId !== BigInt(expectedChainId)) {
    fail(`EVM chain ID is ${network.chainId}, expected ${expectedChainId}`);
  } else {
    pass(`EVM RPC ${evmRpc}, chain ${network.chainId}, block ${await provider.getBlockNumber()}`);
  }

  const balance = await provider.getBalance(deployer.address);
  balance > 0n
    ? pass(`deployer ${deployer.address} has ${ethers.formatEther(balance)} WETH for gas`)
    : fail(`deployer ${deployer.address} has no WETH for gas`);

  const owner = env("OWNER_ADDRESS");
  if (!ethers.isAddress(owner || "")) {
    fail("OWNER_ADDRESS must be a governance-controlled EVM address");
  } else if (netName === "mainnet" && owner.toLowerCase() === deployer.address.toLowerCase()) {
    fail("OWNER_ADDRESS is the deployer; mainnet factory and ProxyAdmin ownership must go to governance");
  } else {
    pass(`post-deploy owner ${owner}`);
  }

  numberIn("FEE", 1, 1_000_000);
  const protocolFee = numberIn("FEE_PROTOCOL", 0, 10);
  if (protocolFee !== undefined && protocolFee !== 0 && protocolFee < 4) {
    fail("FEE_PROTOCOL must be 0 or 4..10");
  }
  const twap = numberIn("TWAP_WINDOW_SECS", 1, 7 * 24 * 60 * 60);
  const blockTime = numberIn("BLOCK_TIME_SECS", 1, 60);
  const cardinality = numberIn("OBS_CARDINALITY", 2, 65_535);
  if (twap && blockTime && cardinality) {
    const minimum = Math.ceil(twap / blockTime) + 1;
    cardinality >= minimum
      ? pass(`observation ring covers at least the ${twap}s TWAP window`)
      : fail(`OBS_CARDINALITY=${cardinality} is below ${minimum}, the minimum for a ${twap}s window`);
  }

  await checkPrice(provider);

  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
  try {
    pass(`Substrate WS ${wsUrl}: ${await api.rpc.system.chain()}`);
    await checkAssetPair(api, provider);
    if (!api.tx.parameters?.setUniswapV3Addresses) {
      note("runtime has no parameters.setUniswapV3Addresses; router registration will be skipped");
    } else {
      pass("runtime supports parameters.setUniswapV3Addresses");
    }
  } finally {
    await api.disconnect();
  }

  console.log("");
  if (failures) throw new Error(`${failures} preflight check(s) failed`);
  console.log("=== preflight passed ===");
}

main().catch((error) => {
  console.error(`\nPreflight failed: ${error.message}\n`);
  process.exit(1);
});
