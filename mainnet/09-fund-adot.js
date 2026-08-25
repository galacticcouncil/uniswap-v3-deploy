/**
 * 09-fund-adot.js — TESTNET ONLY. Move aDOT from the treasury to the deployer.
 *
 * `05-testnet-govern.js` does this with
 * `dispatchAsTreasury(currencies.transfer(...))`, which routes through
 * Erc20Currency. On lark4 that enacted and moved nothing — the dispatcher
 * returns Ok whether or not the inner call worked, so it fails silently.
 *
 * This takes the direct route instead: `evm.call` with `source` = the treasury's
 * EVM address, calling `transfer` on the aToken contract. That address holds the
 * aDOT, and `EnsureAddressTruncated` lets the treasury account act as it because
 * the account's first 20 bytes ARE that address. Verified with a static call
 * before submitting.
 */
const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring } = require("@polkadot/keyring");
const { cryptoWaitReady } = require("@polkadot/util-crypto");
const { env, resolveAssetAddress } = require("./lib");

const TREASURY_EVM = "0x6d6f646c70792f74727372790000000000000000"; // modl ++ py/trsry ++ pad
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const send = (api, tx, signer, label) =>
  new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return reject(new Error(`${label}: ${m ? `${m.section}.${m.name}` : dispatchError.toString()}`));
      }
      if (status.isInBlock) { console.log(`     ${label} in block`); resolve({ events }); }
    }).catch(reject);
  });

async function main() {
  const assetA = Number(env("TOKEN_A", "1001"));
  const amount = BigInt(env("FUND_A", "3000000000000").split(/\s/)[0]);
  const deployer = new ethers.Wallet(env("DEPLOYER_PK")).address;
  const evmRpc = env("EVM_RPC_URL");

  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(env("WS_URL"), 3000) });
  try {
    const token = await resolveAssetAddress(api, assetA);
    const iface = new ethers.Interface(["function transfer(address,uint256) returns (bool)"]);
    const input = iface.encodeFunctionData("transfer", [deployer, amount]);
    console.log(`=== Fund ${deployer} with ${amount} of asset ${assetA} ===`);
    console.log(`  token    ${token}`);
    console.log(`  from     ${TREASURY_EVM} (treasury)`);

    // Prove it before spending a referendum on it.
    const p = new ethers.JsonRpcProvider(evmRpc);
    await p.call({ from: TREASURY_EVM, to: token, data: input });
    console.log("  static call OK — the transfer would succeed");

    const inner = api.tx.dispatcher.dispatchAsTreasury(
      api.tx.evm.call(TREASURY_EVM, token, input, 0, 5000000, 100000000000, null, null, [], [])
    );
    const callHex = inner.method.toHex();
    const len = (callHex.length - 2) / 2;

    const signer = new Keyring({ type: "sr25519", ss58Format: 63 }).addFromUri(env("GOV_SURI", "//Alice"));
    const free = (await api.query.system.account(signer.address)).data.free.toBigInt();

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
    }), signer, "vote aye");

    const erc = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], p);
    console.log("     waiting for the balance to move...");
    for (let i = 0; i < 60; i++) {
      const bal = await erc.balanceOf(deployer);
      if (bal >= amount) { console.log(`\n  ✓ deployer now holds ${ethers.formatUnits(bal, 10)} aDOT`); return; }
      if (i % 5 === 0) console.log(`     [${i}] balance ${ethers.formatUnits(bal, 10)}`);
      await sleep(6000);
    }
    throw new Error("balance did not move — check the evm.Executed/ExecutedFailed events");
  } finally { await api.disconnect(); }
}
main().catch((e) => { console.error("\n  FUND FAILED:", e.message, "\n"); process.exit(1); });
