// Unit tests for the pure parts of fee-setter-calls.js: which pools the
// deployment records name, and which of them ICE does not route through yet.

const assert = require("node:assert/strict");
const test = require("node:test");
const { recordPools, icePending } = require("../fee-setter-calls");

const POOL_1 = "0x5c6208a3c316a801f8996750aa7b6f45fc988548"; // aDOT/HOLLAR
const POOLS_2_5 = [
  "0x16e1cbd04029566244f832a90fecc0752cc3d419", // gsol-hollar
  "0x419f96a1a34c422fa581e89c317c1b55563009b4", // apaxg-hollar
  "0x9e30d2429028a436d48d0e83ac806dcd67ef4ca7", // geth-hollar
  "0xdd7e022582d055e35455952f86f76924884a9d1a", // atbtc-hollar
];
const ALL = [POOL_1, ...POOLS_2_5];

test("the mainnet records name pool 1 and pools 2-5", () => {
  assert.deepEqual(recordPools("mainnet").map((p) => p.toLowerCase()).sort(), [...ALL].sort());
});

test("today's mainnet routing lists only pool 1, so pools 2-5 are added", () => {
  const routing = [[{ uniswapV3Pool: POOL_1 }, "Included"], [{ aaveWraps: [[5, 1001]] }, "Included"]];
  assert.deepEqual(icePending(ALL, routing), { add: POOLS_2_5, excluded: [] });
});

test("pools already in an Included batch are not added again", () => {
  const routing = [[{ uniswapV3Pool: POOL_1 }, "Included"], [{ uniswapV3Pools: POOLS_2_5 }, "Included"]];
  assert.deepEqual(icePending(ALL, routing), { add: [], excluded: [] });
});

test("a pool with its own Excluded entry is reported, not added", () => {
  const vetoed = POOLS_2_5[1];
  const routing = [[{ uniswapV3Pool: POOL_1 }, "Included"], [{ uniswapV3Pool: vetoed }, "Excluded"]];
  const { add, excluded } = icePending(ALL, routing);
  assert.deepEqual(excluded, [vetoed]);
  assert.deepEqual(add, POOLS_2_5.filter((p) => p !== vetoed));
});

test("addresses match whatever their letter case", () => {
  const routing = [[{ uniswapV3Pool: POOL_1.toUpperCase().replace("0X", "0x") }, "Included"]];
  const mixedCase = ALL.map((p, i) => (i % 2 ? p.toUpperCase().replace("0X", "0x") : p));
  assert.deepEqual(icePending(mixedCase, routing).add, POOLS_2_5);
});
