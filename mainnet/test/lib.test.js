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
