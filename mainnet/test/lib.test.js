const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assetToEvmAddress,
  parsePriceToE18,
  sqrtPriceX96FromPrice,
  priceE18FromSqrtPriceX96,
} = require("../lib");

test("asset aliases use the Hydration asset-ID encoding", () => {
  assert.equal(assetToEvmAddress(20), "0x0000000000000000000000000000000100000014");
  assert.equal(assetToEvmAddress(1001), "0x00000000000000000000000000000001000003e9");
});

test("price parser accepts fixed decimals and rejects ambiguous input", () => {
  assert.equal(parsePriceToE18("0.9"), 900000000000000000n);
  assert.equal(parsePriceToE18("12.345"), 12345000000000000000n);
  for (const input of ["", "1e3", "-1", ".5", "1."]) {
    assert.throws(() => parsePriceToE18(input));
  }
});

test("sqrt-price conversion remains orientation and decimal aware", () => {
  const price = parsePriceToE18("0.900622");
  const sqrt0 = sqrtPriceX96FromPrice(price, 10, 18, true);
  const roundTrip0 = priceE18FromSqrtPriceX96(sqrt0, 10, 18, true);
  const sqrt1 = sqrtPriceX96FromPrice(price, 10, 18, false);
  const roundTrip1 = priceE18FromSqrtPriceX96(sqrt1, 10, 18, false);

  // The integer square root deliberately rounds down; both orientations should
  // still recover the configured human price within one part per million.
  for (const roundTrip of [roundTrip0, roundTrip1]) {
    const difference = roundTrip > price ? roundTrip - price : price - roundTrip;
    assert.ok(difference * 1_000_000n <= price, `${roundTrip} is outside 1 ppm`);
  }
});

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { POOL_KEYS, poolSplitProblems, poolRecordPath } = require("../lib");

const tickOf = (sqrtPriceX96) => Math.floor(Math.log((Number(sqrtPriceX96) / 2 ** 96) ** 2) / Math.log(1.0001));

test("a flipped pair initializes on the negative tick the runbook expects", () => {
  // atBTC/HOLLAR: HOLLAR is token0, so 84,727.55 HOLLAR per atBTC is tick -113,478 (runbook §1b).
  const sqrt = sqrtPriceX96FromPrice(parsePriceToE18("84727.55"), 18, 18, false);
  assert.ok(Math.abs(tickOf(sqrt) + 113478) <= 1, `tick ${tickOf(sqrt)}`);
  // aPAXG/HOLLAR keeps aPAXG as token0: 4,330.31 is tick +83,738.
  const sqrtPaxg = sqrtPriceX96FromPrice(parsePriceToE18("4330.31"), 18, 18, true);
  assert.ok(Math.abs(tickOf(sqrtPaxg) - 83738) <= 1, `tick ${tickOf(sqrtPaxg)}`);
});

test("a pool file may carry only per-pool keys, and the shared file none of them", () => {
  const pool = { POOL_NAME: "atbtc-hollar", TOKEN_A: "1006" };
  assert.deepEqual(poolSplitProblems(pool, { NET: "mainnet" }, {}), []);
  assert.match(poolSplitProblems({ ...pool, DEPLOYER_PK: "0x1" }, {}, {})[0], /DEPLOYER_PK, which is shared/);
  assert.match(poolSplitProblems(pool, { PRICE_FEED_A: "0xFB" }, {})[0], /ENV_FILE sets PRICE_FEED_A/);
  assert.match(poolSplitProblems(pool, {}, { TOKEN_A: "1001" })[0], /TOKEN_A is also set in the shell/);
  assert.match(poolSplitProblems({ TOKEN_A: "1006" }, {}, {})[0], /POOL_NAME/);
});

test("every committed pool file splits cleanly against the shared example", () => {
  const shared = dotenv.parse(fs.readFileSync(path.join(__dirname, "..", ".env.pools.example")));
  const dir = path.join(__dirname, "..", "pools");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".env"));
  assert.equal(files.length, 4);
  for (const file of files) {
    const pool = dotenv.parse(fs.readFileSync(path.join(dir, file)));
    assert.deepEqual(poolSplitProblems(pool, shared, {}), [], file);
    assert.equal(`${pool.POOL_NAME}.env`, file);
    for (const key of ["TOKEN_A", "TOKEN_B", "EXPECT_TOKEN0", "EXPECT_TOKEN1", "PRICE_FEED_A", "STALE_SECONDS"]) {
      assert.ok(pool[key], `${file} must set ${key}`);
    }
  }
  assert.ok(POOL_KEYS.includes("PRICE_FEED_A"));
});

test("each pool keeps its own creation record", () => {
  delete process.env.POOL_NAME;
  assert.equal(poolRecordPath("mainnet"), path.join("deployments", "mainnet-pool.json"));
  process.env.POOL_NAME = "geth-hollar";
  assert.equal(poolRecordPath("mainnet"), path.join("deployments", "mainnet-pool-geth-hollar.json"));
  delete process.env.POOL_NAME;
});
