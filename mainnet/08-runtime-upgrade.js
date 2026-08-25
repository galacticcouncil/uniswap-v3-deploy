/**
 * 08-runtime-upgrade.js — TESTNET ONLY. Enact a runtime upgrade on a lark fork.
 *
 * `system.setCode` is Root-only, and the WASM is ~2.3 MB, so it cannot be
 * inlined in the referendum — it goes in as a preimage and the referendum
 * carries only {hash, len}.
 *
 * The chain enforces the one rule that matters here: `can_set_code` rejects a
 * blob whose spec_version is <= the running one, so a stale or wrong-branch
 * build fails at enactment rather than silently doing nothing.
 *
 *   node 08-runtime-upgrade.js <path-to.compact.compressed.wasm>
 */
const fs = require("fs");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring } = require("@polkadot/keyring");
const { cryptoWaitReady, blake2AsHex } = require("@polkadot/util-crypto");
const { env } = require("./lib");

const HDX_DECIMALS = 12n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signAndSend(api, tx, signer, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const m = api.registry.findMetaError(dispatchError.asModule);
          return reject(new Error(`${label}: ${m.section}.${m.name}`));
        }
        return reject(new Error(`${label}: ${dispatchError.toString()}`));
      }
      if (status.isInBlock) {
        console.log(`     ${label} in block`);
        resolve({ events });
      }
    }).catch(reject);
  });
}

async function main() {
  const wasmPath = process.argv[2];
  if (!wasmPath) throw new Error("usage: node 08-runtime-upgrade.js <runtime.compact.compressed.wasm>");
  const wasm = fs.readFileSync(wasmPath);
  const codeHex = "0x" + wasm.toString("hex");
  console.log(`=== Runtime upgrade on ${env("NET", "lark4")} ===`);
  console.log(`  wasm      ${wasmPath}`);
  console.log(`  size      ${wasm.length} bytes`);
  console.log(`  blake2    ${blake2AsHex(codeHex)}`);

  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(env("WS_URL", "wss://node4.lark.hydration.cloud"), 3000) });
  try {
    const before = api.runtimeVersion.specVersion.toNumber();
    console.log(`  chain     spec ${before}`);

    const isTestnet = await api.query.parameters.isTestnet();
    if (!isTestnet.isTrue) throw new Error("refusing: Parameters::IsTestnet is false — this is not a lark fork");

    const signer = new Keyring({ type: "sr25519", ss58Format: 63 }).addFromUri(env("GOV_SURI", "//Alice"));
    const free = (await api.query.system.account(signer.address)).data.free.toBigInt();
    console.log(`  signer    ${signer.address} (${(Number(free) / 1e12).toFixed(0)} HDX)`);

    const inner = api.tx.system.setCode(codeHex);
    const callHex = inner.method.toHex();
    const lenBytes = (callHex.length - 2) / 2;
    const hash = inner.method.hash.toHex();

    // Preimage first: a 2.3 MB call cannot be inlined in the referendum.
    try {
      await signAndSend(api, api.tx.preimage.notePreimage(callHex), signer, `notePreimage (${lenBytes} bytes)`);
    } catch (e) {
      if (!String(e).includes("AlreadyNoted")) throw e;
      console.log("     preimage already noted");
    }

    const submitted = await signAndSend(
      api,
      api.tx.referenda.submit({ system: "Root" }, { Lookup: { hash, len: lenBytes } }, { After: 1 }),
      signer,
      "referenda.submit (Root)"
    );
    let refIndex = null;
    for (const { event } of submitted.events) {
      if (event.section === "referenda" && event.method === "Submitted") refIndex = Number(event.data[0].toString());
    }
    if (refIndex === null) throw new Error("no referenda.Submitted event");
    console.log(`     referendum #${refIndex}`);

    await signAndSend(api, api.tx.referenda.placeDecisionDeposit(refIndex), signer, "placeDecisionDeposit");

    // Vote with most of the balance at Locked1x — on a mainnet fork the support
    // threshold is measured against total issuance, so a token vote does not pass.
    const voteBal = (free * 9n) / 10n;
    await signAndSend(
      api,
      api.tx.convictionVoting.vote(refIndex, {
        Standard: { vote: { aye: true, conviction: "Locked1x" }, balance: voteBal },
      }),
      signer,
      `vote aye with ${(Number(voteBal) / 1e12).toFixed(0)} HDX (Locked1x)`
    );

    console.log("     waiting for enactment (spec must increase)...");
    for (let i = 0; i < 100; i++) {
      const v = await api.rpc.state.getRuntimeVersion();
      const now = v.specVersion.toNumber();
      if (now > before) {
        console.log(`\n  ✓ UPGRADED  spec ${before} -> ${now}`);
        return;
      }
      const info = (await api.query.referenda.referendumInfoFor(refIndex)).toHuman();
      const state = info ? Object.keys(info)[0] : "gone";
      if (["Rejected", "Cancelled", "TimedOut", "Killed"].includes(state)) {
        throw new Error(`referendum ${state}: ${JSON.stringify(info)}`);
      }
      if (i % 5 === 0) console.log(`     [${i}] ref=${state} spec=${now}`);
      await sleep(6000);
    }
    throw new Error("spec_version did not increase within timeout");
  } finally {
    await api.disconnect();
  }
}

main().catch((e) => {
  console.error("\n  UPGRADE FAILED:", e.message, "\n");
  process.exit(1);
});
