/**
 * The calls behind `01-governance-calldata.js handover | ice | handover-ice`:
 * hand the factory to UniswapV3FeeSetter, switch the recorded pools below 4/4
 * on through it, and add the pools to ICE's solver routing (money-market #67).
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { blake2AsHex } = require("@polkadot/util-crypto");
const { env, gasOverrides, loadDeployments, ABI } = require("./lib");

const AAVE_MANAGER_EVM = "0xaa7e0000000000000000000000000000000aa7e0";
// The scheduler reserves proof size for an evm.call from its gas limit, and the
// handover puts several in one batch, so each limit is kept tight.
const EVM_CALL_GAS = 200_000n;
const MAX_ROUTING_BATCH = 64; // ice_support::MAX_ROUTING_BATCH
const lower = (address) => address.toLowerCase();

/** Every pool this deployment created: deployments/<net>-pool.json and <net>-pool-<name>.json. */
function recordPools(net) {
  const dir = path.join(__dirname, "deployments");
  const record = new RegExp(`^${net}-pool(-[a-z0-9-]+)?\\.json$`);
  return fs
    .readdirSync(dir)
    .filter((file) => record.test(file))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).pool);
}

/**
 * Which pools ICE does not route through yet. A pool counts as listed when an
 * Included entry names it, alone or in a batch. Excluded is a veto and wins, so a
 * vetoed pool is reported, never re-added. `routing` is `ice.solverRouting.entries()`
 * as JSON: [[{ uniswapV3Pool } | { uniswapV3Pools }, "Included" | "Excluded"], ...].
 */
function icePending(pools, routing) {
  const included = new Set();
  const excluded = new Set();
  for (const [target, state] of routing) {
    const named = target.uniswapV3Pool ? [target.uniswapV3Pool] : target.uniswapV3Pools ?? [];
    for (const pool of named) (state === "Excluded" ? excluded : included).add(lower(pool));
  }
  const wanted = [...new Set(pools.map(lower))].sort();
  return {
    add: wanted.filter((pool) => !included.has(pool) && !excluded.has(pool)),
    excluded: wanted.filter((pool) => excluded.has(pool)),
  };
}

/** One EVM call, dispatched as the Aave manager. */
async function asAaveManager(api, provider, target, data) {
  const gas = await gasOverrides(provider, { gasLimit: EVM_CALL_GAS });
  return api.tx.dispatcher.dispatchAsAaveManager(
    api.tx.evm.call(AAVE_MANAGER_EVM, target, data, 0, gas.gasLimit, gas.gasPrice, null, null, [], [])
  );
}

// The recorded setter must be live and point at this factory and this manager,
// and the manager must still be reachable; otherwise the proposal enacts Ok and does nothing.
async function checkedSetter(api, provider, uniswap) {
  const setter = uniswap.feeSetter;
  if (!setter) throw new Error("no uniswap.feeSetter in the deployment record; run 06-deploy-fee-setter.js first");
  if ((await provider.getCode(setter)) === "0x") throw new Error(`feeSetter ${setter} has no code on this chain`);
  const contract = new ethers.Contract(setter, ABI.feeSetter, provider);
  const [factory, manager] = await Promise.all([contract.FACTORY(), contract.MANAGER()]);
  if (lower(factory) !== lower(uniswap.v3CoreFactory)) throw new Error(`feeSetter.FACTORY() is ${factory}, not ${uniswap.v3CoreFactory}`);
  if (lower(manager) !== AAVE_MANAGER_EVM) throw new Error(`feeSetter.MANAGER() is ${manager}, not ${AAVE_MANAGER_EVM}`);
  const onChain = await api.query.dispatcher.aaveManagerAccount();
  const managerEvm = "0x" + Buffer.from(onChain.toU8a().slice(0, 20)).toString("hex");
  if (managerEvm !== AAVE_MANAGER_EVM) throw new Error(`dispatcher Aave-manager account is now ${managerEvm}`);
  return setter;
}

/**
 * setOwner(setter) while the Aave manager still owns the factory, then setFee for
 * every recorded pool below 4/4. setOwner goes first: setFee needs the setter to
 * be the owner. Each pool must be one the factory itself lists.
 */
async function handoverCalls(api, provider) {
  const net = env("NET", "mainnet");
  const { uniswap } = loadDeployments(net);
  const setter = await checkedSetter(api, provider, uniswap);
  const factory = new ethers.Contract(uniswap.v3CoreFactory, ABI.factory, provider);
  const calls = [];

  const owner = await factory.owner();
  if (lower(owner) === AAVE_MANAGER_EVM) {
    calls.push(await asAaveManager(api, provider, uniswap.v3CoreFactory, factory.interface.encodeFunctionData("setOwner", [setter])));
    console.log(`  + factory.setOwner(${setter})`);
  } else if (lower(owner) !== lower(setter)) {
    throw new Error(`factory owner is ${owner}, neither the Aave manager nor the setter`);
  }

  // No records would make a green rehearsal of a different call than mainnet's.
  const pools = recordPools(net);
  if (!pools.length) throw new Error(`no deployments/${net}-pool*.json records; on a fork, copy the mainnet ones first`);
  const setFee = new ethers.Interface(ABI.feeSetter);
  for (const address of pools) {
    const pool = new ethers.Contract(address, ABI.pool, provider);
    const [slot0, token0, token1, fee] = await Promise.all([pool.slot0(), pool.token0(), pool.token1(), pool.fee()]);
    if (Number(slot0.feeProtocol) === 4 + (4 << 4)) {
      console.log(`  = ${address} already at 4/4`);
      continue;
    }
    if (lower(await factory.getPool(token0, token1, fee)) !== lower(address)) throw new Error(`${address} is not a pool of this factory`);
    // An uninitialized pool's lock makes setFee revert inside an evm.call that still reports Ok.
    if (slot0.sqrtPriceX96 === 0n) throw new Error(`${address} is not initialized`);
    calls.push(await asAaveManager(api, provider, setter, setFee.encodeFunctionData("setFee", [address])));
    console.log(`  + feeSetter.setFee(${address})`);
  }
  return calls;
}

/** `ice.solverRouting.entries()` as the JSON `icePending` reads. */
async function iceRouting(api) {
  return (await api.query.ice.solverRouting.entries()).map(([key, state]) => [key.args[0].toJSON(), state.toString()]);
}

/** ice.updateRouting(UniswapV3Pools([...]), Included) for the recorded pools ICE does not list yet. */
async function iceCall(api) {
  if (!api.tx.ice?.updateRouting) throw new Error("runtime has no ice.updateRouting");
  const { add, excluded } = icePending(recordPools(env("NET", "mainnet")), await iceRouting(api));
  for (const pool of excluded) console.log(`  ! ${pool} is Excluded in ICE routing; left out`);
  if (!add.length) return undefined;
  if (add.length > MAX_ROUTING_BATCH) throw new Error(`${add.length} pools exceed one routing batch (${MAX_ROUTING_BATCH})`);
  console.log(`  + ice.updateRouting(UniswapV3Pools([${add.join(", ")}]), Included)`);
  return api.tx.ice.updateRouting({ UniswapV3Pools: add }, "Included");
}

/**
 * The one Root referendum: the handover calls, then the ICE routing call. Both
 * `01-governance-calldata.js handover-ice` and the fork rehearsal build it here,
 * so what is rehearsed is byte for byte what gets submitted.
 */
async function handoverIceCall(api, provider) {
  const calls = await handoverCalls(api, provider);
  const ice = await iceCall(api);
  if (ice) calls.push(ice);
  if (!calls.length) return undefined;
  return calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls);
}

/** What the submitter does with a Root proposal: three extrinsics, from any funded account. */
async function printSubmission(api, proposal) {
  const encoded = proposal.method.toHex();
  const len = (encoded.length - 2) / 2;
  const hash = blake2AsHex(encoded);
  const note = api.tx.preimage.notePreimage(encoded);
  const submit = api.tx.referenda.submit({ system: "Root" }, { Lookup: { hash, len } }, { After: 1 });
  const index = (await api.query.referenda.referendumCount()).toNumber();
  const link = (call) =>
    `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(env("WS_URL", "wss://rpc.hydradx.cloud"))}#/extrinsics/decode/${call.method.toHex()}`;

  console.log("\n=== to submit: three extrinsics, from any funded account ===");
  console.log("  1. preimage.notePreimage(<the encoded call above>)");
  console.log(`     ${link(note)}`);
  console.log(`  2. referenda.submit(Root, Lookup(${hash}, ${len}), After 1)`);
  console.log(`     ${link(submit)}`);
  console.log(`  3. referenda.placeDecisionDeposit(${index})   # ${index} is the next index; confirm it in the Submitted event`);
  console.log("  after enactment: npm run verify per pool, and npm run verify -- events <enactment block> <count>");
}

/** A Technical Committee motion around `proposal`: what one member submits, and how it closes. */
async function printMotion(api, title, proposal) {
  const members = await api.query.technicalCommittee.members();
  const threshold = Math.ceil(members.length / 2); // TechCommitteeMajority: at least half
  const lengthBound = proposal.method.toU8a().length;
  const { weight } = await proposal.paymentInfo(members[0]);
  const index = (await api.query.technicalCommittee.proposalCount()).toNumber();
  const hash = proposal.method.hash.toHex();
  const motion = api.tx.technicalCommittee.propose(threshold, proposal, lengthBound);
  const motionHex = motion.method.toHex();
  const wsUrl = env("WS_URL", "wss://rpc.hydradx.cloud");

  console.log(`\n=== ${title} ===`);
  console.log(`  proposal:       ${proposal.method.section}.${proposal.method.method}`);
  console.log(`  encoded:        ${proposal.method.toHex()}`);
  console.log(`  proposal hash:  ${hash}`);
  console.log(`  length bound:   ${lengthBound}`);
  console.log(`  weight bound:   refTime ${weight.refTime}, proofSize ${weight.proofSize}`);
  console.log("\n=== motion: what one committee member submits ===");
  console.log(`  call:           technicalCommittee.propose(${threshold}, <proposal>, ${lengthBound})`);
  console.log(`  encoded:        ${motionHex}`);
  console.log(`  polkadot.js:    https://polkadot.js.org/apps/?rpc=${encodeURIComponent(wsUrl)}#/extrinsics/decode/${motionHex}`);
  console.log(`  threshold:      ${threshold} of ${members.length} members (at least half)`);
  console.log("  then:");
  console.log(`    1. one member submits the motion; it should get index ${index}`);
  console.log(`    2. ${threshold} members vote aye, the proposer too: technicalCommittee.vote(${hash}, ${index}, true)`);
  console.log(`    3. anyone closes it: technicalCommittee.close(${hash}, ${index}, <weight bound>, ${lengthBound})`);
  console.log("    4. read ice.solverRouting for the batch: it must be Included");
}

module.exports = {
  AAVE_MANAGER_EVM,
  recordPools,
  icePending,
  iceRouting,
  handoverCalls,
  iceCall,
  handoverIceCall,
  printSubmission,
  printMotion,
};
