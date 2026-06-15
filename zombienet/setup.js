/**
 * setup.js  —  one-time on-chain setup so the EVM can charge gas in WETH (asset 20):
 *   1. set WETH's XCM location  -> WethAssetId resolves to asset 20
 *   2. add WETH as an accepted fee currency -> EVM fee withdrawal works
 *
 * Batched into a single GeneralAdmin referendum that passes in ~1 block thanks to
 * Parameters::IsTestnet=true. After this the deployer's funded WETH becomes visible
 * and gas works. KSM(1)/KUSD(2) (the pool pair) need no governance.
 *
 * Run directly (`node setup.js`) or import { setup }. Env: WS_URL (ws://127.0.0.1:9999).
 */

const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring } = require("@polkadot/keyring");
const { blake2AsHex } = require("@polkadot/util-crypto");

const WS_URL = process.env.WS_URL || "ws://127.0.0.1:9999";
const DEPLOYER_EVM = "0xC19A2970A13ac19898c47d59Cbd0278D428EBC7c";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendAndWait(tx, signer, api) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${d.section}.${d.name}: ${d.docs.join(" ")}`));
        } else reject(new Error(dispatchError.toString()));
        return;
      }
      if (status.isInBlock) resolve({ blockHash: status.asInBlock, events });
    }).catch(reject);
  });
}

async function setup() {
  console.log("=== Chain setup: WETH location + accepted fee currency ===");
  console.log(`  RPC: ${WS_URL}`);

  const api = await ApiPromise.create({ provider: new WsProvider(WS_URL) });
  try {
    console.log(`  Connected to: ${await api.rpc.system.chain()}`);

    if (!(await api.query.parameters.isTestnet()).isTrue) {
      throw new Error("Parameters::IsTestnet is false — rebuild chainspec + restart zombienet.");
    }

    const alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
    const aliceFree = (await api.query.system.account(alice.address)).data.free.toBigInt();

    const pre = await api.rpc.eth.getBalance(DEPLOYER_EVM).catch(() => null);
    if (pre && BigInt(pre.toString()) > 0n) {
      console.log(`  Already set up. EVM WETH balance: ${pre.toHex()}`);
      return;
    }

    // Runtime's hardcoded weth_asset_location() — asset 20 must register to it.
    const wethLocation = {
      parents: 1,
      interior: {
        X3: [
          { Parachain: 2004 },
          { PalletInstance: 110 },
          { AccountKey20: { key: "0xab3f0245b83feb11d15aaffefd7ad465a59817ed" } },
        ],
      },
    };
    const batch = api.tx.utility.batchAll([
      api.tx.assetRegistry.update(20, null, null, null, null, null, null, null, wethLocation),
      api.tx.multiTransactionPayment.addCurrency(20, "1000000000000000000"), // Price::from(1)
    ]);
    const encoded = batch.method.toHex();
    const hash = blake2AsHex(encoded);

    console.log("  [1/5] Note preimage...");
    try {
      await sendAndWait(api.tx.preimage.notePreimage(encoded), alice, api);
    } catch (e) {
      if (!e.message.includes("AlreadyNoted")) throw e;
    }

    console.log("  [2/5] Submit referendum (GeneralAdmin)...");
    const { events } = await sendAndWait(
      api.tx.referenda.submit({ Origins: "GeneralAdmin" }, { Lookup: { hash, len: encoded.length / 2 - 1 } }, { After: 1 }),
      alice,
      api
    );
    const submitted = events.find((e) => e.event.section === "referenda" && e.event.method === "Submitted");
    if (!submitted) throw new Error("No referenda.Submitted event");
    const refIndex = submitted.event.data[0].toNumber();
    console.log(`    Referendum #${refIndex}`);

    console.log("  [3/5] Decision deposit...");
    await sendAndWait(api.tx.referenda.placeDecisionDeposit(refIndex), alice, api);

    console.log("  [4/5] Vote AYE...");
    await sendAndWait(
      api.tx.convictionVoting.vote(refIndex, {
        Standard: { balance: (aliceFree * 9n) / 10n, vote: { aye: true, conviction: "Locked1x" } },
      }),
      alice,
      api
    );

    console.log("  [5/5] Wait for enactment...");
    for (let i = 0; i < 60; i++) {
      await sleep(6000);
      const info = (await api.query.referenda.referendumInfoFor(refIndex)).toJSON();
      if (info.approved) {
        console.log(`    Referendum #${refIndex} approved.`);
        break;
      }
      if (info.rejected) throw new Error(`Referendum #${refIndex} rejected`);
      if (info.timedOut) throw new Error(`Referendum #${refIndex} timed out`);
    }

    await sleep(6000);
    const wei = BigInt((await api.rpc.eth.getBalance(DEPLOYER_EVM).catch(() => "0x0")).toString());
    console.log(`  EVM WETH balance: ${wei / 10n ** 18n} WETH`);
    if (wei === 0n) throw new Error("EVM balance still 0 after setup");
    console.log("  Setup complete — EVM ready.");
  } finally {
    await api.disconnect();
  }
}

if (require.main === module) {
  setup().catch((e) => {
    console.error("\n  Setup FAILED:", e.message, "\n");
    process.exit(1);
  });
}

module.exports = { setup };
