/**
 * Rehearse the fee-setter referendum on a local chopsticks fork: build the exact
 * call `01-governance-calldata.js handover-ice` prints, enact it with Root the way
 * a passed referendum does (scheduler agenda + preimage), then check the result.
 *
 *   ENV_FILE=.env.fork node fork-rehearse-handover.js
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { blake2AsHex } = require("@polkadot/util-crypto");
const { u8aToHex } = require("@polkadot/util");
const { env, loadDeployments, ABI } = require("./lib");
const { handoverIceCall, recordPools, icePending, iceRouting } = require("./fee-setter-calls");

const FAILURE_EVENTS = ["evm.ExecutedFailed", "utility.BatchInterrupted", "system.ExtrinsicFailed", "scheduler.CallUnavailable"];

function assertLocalFork(wsUrl) {
  if (!/(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(wsUrl)) {
    throw new Error(`REFUSING TO RUN: WS_URL is ${wsUrl}. This injects a Root call; local chopsticks fork only.`);
  }
}

// Note the preimage, file the call for the next block with Root, build that block.
// Lookup, not Inline: an Inline call is capped at 128 bytes and silently skipped above it.
async function enactWithRoot(api, call) {
  const encoded = call.method.toHex();
  const len = (encoded.length - 2) / 2;
  const hash = blake2AsHex(encoded);
  await api.rpc("dev_setBlockBuildMode", "Manual");
  const at = (await api.rpc.chain.getHeader()).number.toNumber() + 1;
  await api.rpc("dev_setStorage", [
    [api.query.preimage.preimageFor.key([hash, len]), u8aToHex(api.createType("Bytes", encoded).toU8a())],
  ]);
  const entry = { maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } };
  await api.rpc("dev_setStorage", { Scheduler: { Agenda: [[[at], [entry]]] } });
  console.log(`  enacting preimage ${hash} (${len} bytes) with Root in block ${at} …`);
  await api.rpc("dev_newBlock", {});
  await api.rpc("dev_setBlockBuildMode", "Batch");
  return at;
}

// A skipped agenda entry produces no failure marker at all, so Dispatched must be seen.
async function eventFailures(api, at) {
  const events = await (await api.at(await api.rpc.chain.getBlockHash(at))).query.system.events();
  let failures = 0;
  let dispatched = false;
  let executed = 0;
  for (const { event } of events) {
    const key = `${event.section}.${event.method}`;
    if (key === "evm.Executed") executed += 1;
    if (key === "scheduler.Dispatched") {
      dispatched = true;
      const result = event.data.toJSON()[2];
      if (result?.err) failures += 1;
      console.log(`  ${result?.err ? "✗" : "✓"} scheduler.Dispatched ${JSON.stringify(result)}`);
    }
    if (FAILURE_EVENTS.includes(key)) {
      failures += 1;
      console.log(`  ✗ ${key} ${JSON.stringify(event.data.toHuman())}`);
    }
  }
  if (!dispatched) failures += 1;
  console.log(`  ${dispatched ? "" : "✗ no scheduler.Dispatched; "}${executed} evm.Executed, ${failures} failure marker(s)`);
  return failures;
}

async function stateFailures(api, provider) {
  const net = env("NET", "mainnet"); // the same default the call was built with
  const { uniswap } = loadDeployments(net);
  let failures = 0;
  const check = (ok, message) => {
    console.log(`  ${ok ? "✓" : "✗"} ${message}`);
    if (!ok) failures += 1;
  };
  const owner = await new ethers.Contract(uniswap.v3CoreFactory, ABI.factory, provider).owner();
  check(owner.toLowerCase() === uniswap.feeSetter.toLowerCase(), `factory.owner() ${owner} is the fee setter`);
  for (const pool of recordPools(net)) {
    const packed = Number((await new ethers.Contract(pool, ABI.pool, provider).slot0()).feeProtocol);
    check(packed === 4 + (4 << 4), `${pool} protocol fee ${packed & 0x0f}/${packed >> 4}`);
  }
  const { add, excluded } = icePending(recordPools(net), await iceRouting(api));
  check(!add.length && !excluded.length, `ICE routes every recorded pool${add.length ? `; missing ${add.join(", ")}` : ""}`);
  return failures;
}

async function main() {
  const wsUrl = env("WS_URL", "ws://localhost:8001");
  assertLocalFork(wsUrl);
  // A fresh fork can take minutes to build a block: it fetches mainnet state lazily.
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl, 2500, {}, 15 * 60_000), noInitWarn: true });
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", "http://localhost:8001"));
  try {
    console.log(`=== rehearse the fee-setter referendum on ${wsUrl} ===`);
    const call = await handoverIceCall(api, provider);
    if (!call) throw new Error("nothing to enact: handover and ICE routing are already done on this fork");
    const at = await enactWithRoot(api, call);
    const failures = (await eventFailures(api, at)) + (await stateFailures(api, provider));
    if (failures) throw new Error(`${failures} check(s) failed`);
    console.log(`=== rehearsal passed; for the event scan: npm run verify -- events ${at} 1 ===`);
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => {
  console.error(`\n  rehearsal FAILED: ${error.message}\n`);
  process.exit(1);
});
