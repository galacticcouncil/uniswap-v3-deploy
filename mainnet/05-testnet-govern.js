/**
 * 05-testnet-govern.js — TESTNET ONLY (lark forks). Does in one Root referendum
 * what 01-governance-calldata.js only prints for mainnet:
 *
 *   1. evmAccounts.addContractDeployer(deployer)      — permissioned CREATE
 *   2. fund the deployer with gas + both pool assets
 *
 * Funding is asset-kind aware, which is the whole reason this script exists:
 *
 *   Token assets (WETH 20, DOT 5)  -> currencies.updateBalance (Root mints)
 *   Erc20 assets (HOLLAR 222, aDOT 1001)
 *       -> currencies.updateBalance FAILS with Currencies::NotSupported
 *          (pallets/currencies/src/lib.rs: BoundErc20::contract_address(id).is_some()
 *           => fail!(Error::NotSupported)) because the balance lives in an EVM
 *          contract, not pallet-tokens. So we move real supply instead:
 *          dispatcher.dispatchAsTreasury(currencies.transfer(dest, id, amount)),
 *          which routes through Erc20Currency and does the EVM transfer with the
 *          treasury account's derived EVM address as `from`.
 *
 * Requires a chain where //Alice holds enough HDX to carry a Root referendum
 * alone and Parameters::IsTestnet is true (1-block confirm/enactment tracks).
 */

const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring } = require("@polkadot/keyring");
const { cryptoWaitReady } = require("@polkadot/util-crypto");
const { env, requireEnv } = require("./lib");

const HDX_DECIMALS = 12n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** EVM address -> the ETH-prefixed AccountId32 the runtime maps it to. */
const truncatedAccountId = (evm) =>
  "0x45544800" + evm.toLowerCase().replace(/^0x/, "").padStart(40, "0") + "0000000000000000";

function decodeError(api, dispatchError) {
  if (dispatchError.isModule) {
    const meta = api.registry.findMetaError(dispatchError.asModule);
    return `${meta.section}.${meta.name}: ${meta.docs.join(" ")}`;
  }
  return dispatchError.toString();
}

function signAndSend(api, tx, signer, label) {
  console.log(`  -> ${label}`);
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, (result) => {
      if (result.dispatchError) return reject(new Error(decodeError(api, result.dispatchError)));
      if (result.status.isInBlock) {
        console.log(`     in block ${result.status.asInBlock.toHex()}`);
        resolve(result);
      }
    }).catch(reject);
  });
}

async function submitRootReferendum(api, signer, inner, { voteHdx, enactAfter, verify }) {
  const callHex = inner.method.toHex();
  const lenBytes = (callHex.length - 2) / 2;

  let proposal;
  if (lenBytes <= 100) {
    proposal = { Inline: callHex };
  } else {
    try {
      await signAndSend(api, api.tx.preimage.notePreimage(callHex), signer, `notePreimage (${lenBytes} bytes)`);
    } catch (e) {
      if (!String(e).includes("AlreadyNoted")) throw e;
      console.log("     preimage already noted");
    }
    proposal = { Lookup: { hash: inner.method.hash.toHex(), len: lenBytes } };
  }

  const submitted = await signAndSend(
    api,
    api.tx.referenda.submit({ system: "Root" }, proposal, { After: enactAfter }),
    signer,
    "referenda.submit (Root track)"
  );

  let refIndex = null;
  for (const { event } of submitted.events) {
    if (event.section === "referenda" && event.method === "Submitted") {
      refIndex = Number(event.data[0].toString());
      break;
    }
  }
  if (refIndex === null) throw new Error("no referenda.Submitted event");
  console.log(`     referendum #${refIndex}`);

  await signAndSend(api, api.tx.referenda.placeDecisionDeposit(refIndex), signer, "placeDecisionDeposit");
  await signAndSend(
    api,
    api.tx.convictionVoting.vote(refIndex, {
      Standard: { vote: { aye: true, conviction: "None" }, balance: voteHdx * 10n ** HDX_DECIMALS },
    }),
    signer,
    `vote aye with ${voteHdx} HDX`
  );

  console.log("     waiting for approval...");
  let approved = false;
  for (let i = 0; i < 80; i++) {
    const info = (await api.query.referenda.referendumInfoFor(refIndex)).toHuman();
    if (info?.Approved) {
      approved = true;
      break;
    }
    if (info?.Rejected || info?.Cancelled || info?.TimedOut || info?.Killed) {
      throw new Error(`referendum ended without approval: ${JSON.stringify(info)}`);
    }
    await sleep(6000);
  }
  if (!approved) throw new Error("referendum not approved within timeout");

  console.log("     waiting for enactment...");
  for (let i = 0; i < 40; i++) {
    if (await verify()) {
      console.log("     effect confirmed");
      return refIndex;
    }
    await sleep(6000);
  }
  throw new Error("referendum approved but effect not observed within timeout");
}

/** Asset kind + a balance reader that works for native / Token / Erc20 alike. */
async function assetInfo(api, provider, id) {
  const reg = await api.query.assetRegistry.assets(id);
  if (!reg.isSome) throw new Error(`asset ${id} not registered`);
  const h = reg.unwrap().toHuman();
  let contract = null;
  if (h.assetType === "Erc20") {
    const locQ = api.query.assetRegistry.assetLocations || api.query.assetRegistry.locations;
    const loc = await locQ(id);
    const m = JSON.stringify(loc.toJSON()).match(/"accountKey20":\{[^}]*"key":"(0x[0-9a-fA-F]{40})"/);
    if (!m) throw new Error(`asset ${id} is Erc20 but has no AccountKey20 location`);
    contract = ethers.getAddress(m[1]);
  }
  return { id, symbol: h.symbol, decimals: Number(h.decimals), type: h.assetType, contract };
}

async function balanceOf(api, provider, info, substrateAccount, evmAddress) {
  if (info.type === "Erc20") {
    const erc = new ethers.Contract(info.contract, ["function balanceOf(address) view returns (uint256)"], provider);
    return await erc.balanceOf(evmAddress);
  }
  if (info.id === 0) {
    return BigInt((await api.query.system.account(substrateAccount)).data.free.toString());
  }
  return BigInt((await api.query.tokens.accounts(substrateAccount, info.id)).free.toString());
}

async function main() {
  await cryptoWaitReady();
  const wsUrl = requireEnv("WS_URL");
  const evmRpc = requireEnv("EVM_RPC_URL");
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const deployer = new ethers.Wallet(requireEnv("DEPLOYER_PK")).address;
  const dest = truncatedAccountId(deployer);

  const gasId = Number(env("GAS_ASSET_ID", "20"));
  const assetA = Number(env("TOKEN_A", "5"));
  const assetB = Number(env("TOKEN_B", "222"));
  const fundGas = BigInt(env("FUND_GAS", "100000000000000000000")); // 100 WETH
  const fundA = BigInt(env("FUND_A", "2000000000000000")); //  200k DOT (10 dec)
  const fundB = BigInt(env("FUND_B", "200000000000000000000000")); //  200k HOLLAR (18 dec)

  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
  try {
    const chain = await api.rpc.system.chain();
    const isTestnet = api.query.parameters?.isTestnet ? (await api.query.parameters.isTestnet()).toString() : "?";
    console.log(`=== Testnet governance on ${chain} (isTestnet=${isTestnet}) ===`);
    if (isTestnet !== "true") {
      throw new Error("Parameters::IsTestnet is not true — refusing to run this script on a real network");
    }

    const signer = new Keyring({ type: "sr25519", ss58Format: 63 }).addFromUri(env("GOV_SURI", "//Alice"));
    const hdx = BigInt((await api.query.system.account(signer.address)).data.free.toString()) / 10n ** HDX_DECIMALS;
    console.log(`  gov signer ${signer.address} (${hdx} HDX)`);
    console.log(`  deployer   ${deployer}`);
    console.log(`  mapped     ${dest}`);

    const infos = {};
    for (const id of [gasId, assetA, assetB]) infos[id] = await assetInfo(api, provider, id);
    for (const id of [gasId, assetA, assetB]) {
      const i = infos[id];
      console.log(`  asset ${String(id).padStart(4)}: ${i.symbol.padEnd(7)} ${i.type.padEnd(6)} dec=${i.decimals}${i.contract ? ` @ ${i.contract}` : ""}`);
    }

    const want = { [gasId]: fundGas, [assetA]: fundA, [assetB]: fundB };
    const whitelisted = async () => (await api.query.evmAccounts.contractDeployer(deployer)).isSome;

    const verify = async () => {
      if (!(await whitelisted())) return false;
      for (const id of [gasId, assetA, assetB]) {
        const bal = await balanceOf(api, provider, infos[id], dest, deployer);
        if (BigInt(bal) < want[id]) return false;
      }
      return true;
    };

    if (await verify()) {
      console.log("  already whitelisted and funded — nothing to do");
      return;
    }

    const calls = [];
    if (!(await whitelisted())) {
      calls.push(api.tx.evmAccounts.addContractDeployer(deployer));
      console.log("  + evmAccounts.addContractDeployer");
    }
    for (const id of [gasId, assetA, assetB]) {
      const info = infos[id];
      const have = BigInt(await balanceOf(api, provider, info, dest, deployer));
      const need = want[id] - have;
      if (need <= 0n) {
        console.log(`  = asset ${id} (${info.symbol}) already has ${have}`);
        continue;
      }
      if (info.type === "Erc20") {
        // Root cannot mint an Erc20 asset; move it out of the treasury instead.
        calls.push(
          api.tx.dispatcher.dispatchAsTreasury(api.tx.currencies.transfer(dest, id, need.toString()))
        );
        console.log(`  + dispatchAsTreasury(currencies.transfer ${need} of ${info.symbol})`);
      } else {
        calls.push(api.tx.currencies.updateBalance(dest, id, need.toString()));
        console.log(`  + currencies.updateBalance ${need} of ${info.symbol}`);
      }
    }

    const inner = calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls);
    await submitRootReferendum(api, signer, inner, {
      voteHdx: BigInt(env("VOTE_HDX", "3000000000")),
      enactAfter: Number(env("ENACT_AFTER", "1")),
      verify,
    });

    console.log("\n=== final state ===");
    console.log(`  contractDeployer: ${await whitelisted()}`);
    for (const id of [gasId, assetA, assetB]) {
      const i = infos[id];
      const bal = await balanceOf(api, provider, i, dest, deployer);
      console.log(`  ${i.symbol.padEnd(7)} ${ethers.formatUnits(bal, i.decimals)}`);
    }
  } finally {
    await api.disconnect();
  }
}

main().catch((e) => {
  console.error("\n  testnet-govern FAILED:", e.message, "\n");
  process.exit(1);
});
