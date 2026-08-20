/**
 * lib.js — shared helpers for the mainnet/lark launch scripts.
 *
 * Everything is env-driven (see .env.example); no chain writes happen here.
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch {
  /* dotenv optional — plain env vars work too */
}

const env = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
};

const requireEnv = (name) => {
  const v = env(name);
  if (v === undefined) throw new Error(`missing env: ${name} (see mainnet/.env.example)`);
  return v;
};

// Asset ERC-20 precompile: 0x…01 ++ assetId (big-endian, last 4 bytes).
function assetToEvmAddress(assetId) {
  return "0x" + "0".repeat(30) + "01" + Number(assetId).toString(16).padStart(8, "0");
}

function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function isqrt(n) {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// "4.2" -> 4_200000000000000000n (1e18 fixed point). Rejects exponents.
function parsePriceToE18(s) {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`bad price: ${s} (use a plain decimal like 4.2)`);
  const frac = (m[2] || "").padEnd(18, "0").slice(0, 18);
  return BigInt(m[1]) * 10n ** 18n + BigInt(frac);
}

/**
 * sqrtPriceX96 for pool init.
 * priceE18: TOKEN_B per 1 TOKEN_A, in human units, 1e18 fixed point.
 * decA/decB: ERC-20 decimals. aIsToken0: addr(A) < addr(B).
 * raw price (token1 per token0 in raw units):
 *   A==token0: P * 10^decB / 10^decA      A==token1: 10^decA / (P * 10^decB)
 */
function sqrtPriceX96FromPrice(priceE18, decA, decB, aIsToken0) {
  if (priceE18 <= 0n) throw new Error("price must be positive");
  const E18 = 10n ** 18n;
  const [num, den] = aIsToken0
    ? [priceE18 * 10n ** BigInt(decB), E18 * 10n ** BigInt(decA)]
    : [E18 * 10n ** BigInt(decA), priceE18 * 10n ** BigInt(decB)];
  return isqrt((num << 192n) / den);
}

// Inverse of the above, for sanity printing: sqrtPriceX96 -> human B-per-A, 1e18.
function priceE18FromSqrtPriceX96(sqrtPriceX96, decA, decB, aIsToken0) {
  const E18 = 10n ** 18n;
  // raw t1/t0 in 1e18: (sqrt^2 / 2^192) * 1e18
  const rawE18 = (sqrtPriceX96 * sqrtPriceX96 * E18) >> 192n;
  if (rawE18 === 0n) return 0n;
  return aIsToken0
    ? (rawE18 * 10n ** BigInt(decA)) / 10n ** BigInt(decB)
    : (E18 * E18 * 10n ** BigInt(decA)) / (rawE18 * 10n ** BigInt(decB));
}

const fmtE18 = (x) => {
  const s = (x / 10n ** 12n).toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
};

const ABI = {
  erc20: [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
  ],
  factory: [
    "function owner() view returns (address)",
    "function getPool(address,address,uint24) view returns (address)",
    "function createPool(address,address,uint24) returns (address)",
    "function feeAmountTickSpacing(uint24) view returns (int24)",
    "function enableFeeAmount(uint24,int24)",
    "function setOwner(address)",
  ],
  pool: [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function initialize(uint160)",
    "function increaseObservationCardinalityNext(uint16)",
    "function liquidity() view returns (uint128)",
    "function setFeeProtocol(uint8,uint8)",
    "function collectProtocol(address,uint128,uint128) returns (uint128,uint128)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
  ],
  // Price feeds on Hydration are Chainlink AggregatorV3, NOT DIA getValue(string).
  // DIA is the data SOURCE; the chain serves it through the AggregatorV3 interface
  // (the same feeds the Aave market consumes). Every mainnet feed reverts on
  // getValue() and answers latestRoundData(), verified 2026-08-21.
  // One contract per pair, so the pair is chosen by ADDRESS, not by a string key.
  aggregatorV3: [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
  ],
};

/**
 * Read one AggregatorV3 feed as a 1e18 fixed-point USD price, plus its age.
 * Throws on a stale, zero or negative answer — callers treat any throw as fatal.
 */
async function readFeedE18(ethers, address, provider, staleSeconds) {
  const feed = new ethers.Contract(address, ABI.aggregatorV3, provider);
  const [round, decimals] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
  const answer = round.answer;
  if (answer <= 0n) throw new Error(`feed ${address} returned ${answer}`);
  const age = Math.floor(Date.now() / 1000) - Number(round.updatedAt);
  if (age > staleSeconds) throw new Error(`feed ${address} is stale (${age}s old)`);
  const dec = Number(decimals);
  if (dec > 18) throw new Error(`feed ${address} has ${dec} decimals, expected <= 18`);
  return { priceE18: BigInt(answer) * 10n ** BigInt(18 - dec), age, decimals: dec };
}

function loadDeployments(net) {
  const p = path.join(__dirname, "deployments", `${net}.json`);
  if (!fs.existsSync(p)) throw new Error(`${p} not found — run 02-deploy.js first`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJson(rel, obj) {
  const p = path.join(__dirname, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}

module.exports = {
  env,
  requireEnv,
  readFeedE18,
  assetToEvmAddress,
  sortTokens,
  isqrt,
  parsePriceToE18,
  sqrtPriceX96FromPrice,
  priceE18FromSqrtPriceX96,
  fmtE18,
  ABI,
  loadDeployments,
  saveJson,
};
