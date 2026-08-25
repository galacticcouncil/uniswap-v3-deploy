/**
 * 10-set-router-addresses.js — TESTNET ONLY. Point the runtime's Uniswap v3
 * venue at a deployment (Root referendum).
 *
 * `scripts/uniswap-v3-lark set-addresses` does the same thing but votes a fixed
 * amount at conviction None, which does not clear the Root track's support
 * threshold on a mainnet fork — total issuance is the denominator, so a token
 * vote never gets there. This votes 90% of the signer's balance at Locked1x,
 * which is what carried the runtime upgrade.
 */
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring } = require("@polkadot/keyring");
const { cryptoWaitReady } = require("@polkadot/util-crypto");
const { env, loadDeployments } = require("./lib");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (api, tx, signer, label) =>
  new Promise((res, rej) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return rej(new Error(`${label}: ${m ? `${m.section}.${m.name}` : dispatchError.toString()}`));
      }
      if (status.isInBlock) { console.log(`     ${label} in block`); res({ events }); }
    }).catch(rej);
  });

async function main() {
  const d = loadDeployments(env("NET", "lark4"));
  const { v3CoreFactory, swapRouter02, quoterV2 } = d.uniswap;
  console.log(`=== set uniswap v3 addresses on ${env("NET", "lark4")} ===`);
  console.log(`  factory ${v3CoreFactory}\n  router  ${swapRouter02}\n  quoter  ${quoterV2}`);

  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(env("WS_URL"), 3000) });
  try {
    if (!api.tx.parameters?.setUniswapV3Addresses) throw new Error("runtime has no setUniswapV3Addresses — wrong spec");
    const already = await api.query.parameters.uniswapV3Factory();
    if (already.isSome && already.unwrap().toHex().toLowerCase() === v3CoreFactory.toLowerCase()) {
      console.log("  already set — nothing to do"); return;
    }

    const signer = new Keyring({ type: "sr25519", ss58Format: 63 }).addFromUri(env("GOV_SURI", "//Alice"));
    const free = (await api.query.system.account(signer.address)).data.free.toBigInt();
    const inner = api.tx.parameters.setUniswapV3Addresses(v3CoreFactory, swapRouter02, quoterV2);
    const callHex = inner.method.toHex();
    const len = (callHex.length - 2) / 2;

    let proposal;
    if (len <= 100) proposal = { Inline: callHex };
    else {
      try { await send(api, api.tx.preimage.notePreimage(callHex), signer, `notePreimage (${len}B)`); }
      catch (e) { if (!String(e).includes("AlreadyNoted")) throw e; }
      proposal = { Lookup: { hash: inner.method.hash.toHex(), len } };
    }

    const sub = await send(api, api.tx.referenda.submit({ system: "Root" }, proposal, { After: 1 }), signer, "referenda.submit");
    let idx = null;
    for (const { event } of sub.events) if (event.section === "referenda" && event.method === "Submitted") idx = Number(event.data[0]);
    console.log(`     referendum #${idx}`);
    await send(api, api.tx.referenda.placeDecisionDeposit(idx), signer, "placeDecisionDeposit");
    await send(api, api.tx.convictionVoting.vote(idx, {
      Standard: { vote: { aye: true, conviction: "Locked1x" }, balance: (free * 9n) / 10n },
    }), signer, `vote aye (${(Number(free * 9n / 10n) / 1e12).toFixed(0)} HDX, Locked1x)`);

    console.log("     waiting for the storage to change...");
    for (let i = 0; i < 60; i++) {
      const f = await api.query.parameters.uniswapV3Factory();
      if (f.isSome && f.unwrap().toHex().toLowerCase() === v3CoreFactory.toLowerCase()) {
        console.log(`\n  ✓ router venue configured — factory ${f.unwrap().toHex()}`); return;
      }
      if (i % 5 === 0) console.log(`     [${i}] still unset`);
      await sleep(6000);
    }
    throw new Error("storage did not change within timeout");
  } finally { await api.disconnect(); }
}
main().catch((e) => { console.error("\n  FAILED:", e.message, "\n"); process.exit(1); });
