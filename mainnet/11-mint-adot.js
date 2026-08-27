/**
 * 11-mint-adot.js — TESTNET ONLY. Create aDOT at scale by supplying DOT to Aave.
 *
 * `09-fund-adot.js` moves aDOT that already exists out of the treasury. That caps
 * you at whatever the treasury happens to hold — 54 aDOT on the lark4 snapshot,
 * which is nowhere near enough to seed a pool with real depth. aDOT is only
 * created one way: supply DOT to the Aave market and receive the aToken 1:1.
 *
 * What actually needs governance is only the funding:
 *
 *   1. The deployer holds no DOT. DOT (5) is a `Token`-kind asset, so unlike aDOT
 *      and HOLLAR the runtime CAN mint it — currencies.updateBalance works.
 *   2. HOLLAR is `Erc20`-kind and cannot be minted, so it is moved out of the
 *      treasury — as an evm.call, not currencies.transfer, see 05-testnet-govern.js.
 *
 * Both go in one Root referendum. The reserve-freeze machinery below is kept
 * because a snapshot COULD land on a frozen reserve (Aave's validateSupply
 * rejects one, so supply() would revert) and unfreezing needs PoolAdmin, which
 * 0xaa7e…0aa7e0 holds via dispatcher.dispatchAsAaveManager. On the current lark4
 * snapshot the DOT reserve is NOT frozen and that leg is skipped.
 *
 * Read `isFrozen` from index 9 of getReserveConfigurationData, not index 6.
 * Index 6 is `borrowingEnabled`. Getting that wrong reports a perfectly healthy
 * reserve as frozen and sends you chasing a governance fix you do not need.
 *
 *   node 11-mint-adot.js            # fund + supply (unfreezes only if needed)
 *   node 11-mint-adot.js --refreeze # freeze the reserve (only if you unfroze it)
 *
 * Env: MINT_DOT (whole DOT to supply), FUND_HOLLAR (whole HOLLAR from treasury).
 */
const { ethers } = require("ethers");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring } = require("@polkadot/keyring");
const { cryptoWaitReady } = require("@polkadot/util-crypto");
const { env, requireEnv, resolveAssetAddress } = require("./lib");

const TREASURY_EVM = "0x6d6f646c70792f74727372790000000000000000";
const AAVE_MANAGER_EVM = "0xaa7e0000000000000000000000000000000aa7e0";
const ADDRESSES_PROVIDER = env("AAVE_ADDRESSES_PROVIDER", "0xf3Ba4D1b50f78301BDD7EAEa9B67822A15FCA691");
const DOT_ID = Number(env("DOT_ASSET_ID", "5"));
const HOLLAR_ID = Number(env("TOKEN_B", "222"));
const EVM_CALL_GAS = Number(env("EVM_CALL_GAS", "2000000"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncatedAccountId = (evm) =>
  "0x45544800" + evm.toLowerCase().replace(/^0x/, "").padStart(40, "0") + "0000000000000000";

const CONFIGURATOR_ABI = new ethers.Interface(["function setReserveFreeze(address asset, bool freeze)"]);
const ERC20_ABI = new ethers.Interface(["function transfer(address,uint256) returns (bool)"]);

function signAndSend(api, tx, signer, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return reject(new Error(`${label}: ${m ? `${m.section}.${m.name}` : dispatchError.toString()}`));
      }
      if (status.isInBlock) {
        console.log(`     ${label} in block`);
        resolve({ events });
      }
    }).catch(reject);
  });
}

/** Submit `inner` as a Root referendum and wait for `verify()` to go true. */
async function rootReferendum(api, signer, inner, verify) {
  const preimage = inner.method.toHex();
  const hash = api.registry.hash(inner.method.toU8a()).toHex();
  const len = inner.method.toU8a().length;

  const noted = await api.query.preimage.requestStatusFor(hash);
  if (noted.isNone) await signAndSend(api, api.tx.preimage.notePreimage(preimage), signer, "notePreimage");
  else console.log("     preimage already noted");

  const { events } = await signAndSend(
    api,
    api.tx.referenda.submit({ system: "Root" }, { Lookup: { hash, len } }, { After: 1 }),
    signer,
    "referenda.submit"
  );
  let index = null;
  for (const { event } of events) {
    if (event.section === "referenda" && event.method === "Submitted") index = event.data[0].toNumber();
  }
  if (index === null) throw new Error("no referenda.Submitted event");
  console.log(`     referendum #${index}`);

  await signAndSend(api, api.tx.referenda.placeDecisionDeposit(index), signer, "placeDecisionDeposit");
  const vote = BigInt(env("VOTE_HDX", "3000000000")) * 10n ** 12n;
  await signAndSend(
    api,
    api.tx.convictionVoting.vote(index, { Standard: { vote: { aye: true, conviction: "Locked1x" }, balance: vote.toString() } }),
    signer,
    "vote aye"
  );

  console.log("     waiting for enactment...");
  for (let i = 0; i < 120; i++) {
    if (await verify()) {
      console.log("     effect confirmed");
      return index;
    }
    await sleep(6000);
  }
  throw new Error("referendum did not take effect in time");
}

async function main() {
  const refreeze = process.argv.includes("--refreeze");
  await cryptoWaitReady();

  const provider = new ethers.JsonRpcProvider(requireEnv("EVM_RPC_URL"));
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const api = await ApiPromise.create({ provider: new WsProvider(requireEnv("WS_URL"), 3000), noInitWarn: true });

  try {
    const signer = new Keyring({ type: "sr25519", ss58Format: 63 }).addFromUri(env("GOV_SURI", "//Alice"));
    const dotAddr = await resolveAssetAddress(api, DOT_ID);
    const hollarAddr = await resolveAssetAddress(api, HOLLAR_ID);
    const adotAddr = await resolveAssetAddress(api, Number(env("TOKEN_A", "1001")));

    const ap = new ethers.Contract(ADDRESSES_PROVIDER, ["function getPool() view returns (address)", "function getPoolConfigurator() view returns (address)"], provider);
    const pool = await ap.getPool();
    const configurator = await ap.getPoolConfigurator();

    const dp = new ethers.Contract(
      env("MM_DATA_PROVIDER", "0xdf18300261edfF47b28c6a6adBCBCf468B52e5a5"),
      ["function getReserveConfigurationData(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)"],
      provider
    );
    // getReserveConfigurationData returns
    //   (decimals, ltv, liqThreshold, liqBonus, reserveFactor, usageAsCollateral,
    //    borrowingEnabled, stableBorrowRate, isActive, isFrozen)
    // isFrozen is index 9. Index 6 is borrowingEnabled — reading that one instead
    // reports a healthy reserve as frozen and sends you chasing a governance fix
    // for a problem you do not have.
    const isFrozen = async () => (await dp.getReserveConfigurationData(dotAddr))[9];

    console.log(`=== mint aDOT via Aave on ${env("NET", "lark4")} ===`);
    console.log(`  pool          ${pool}`);
    console.log(`  configurator  ${configurator}`);
    console.log(`  DOT           ${dotAddr}`);
    console.log(`  aDOT          ${adotAddr}`);
    console.log(`  deployer      ${wallet.address}`);
    console.log(`  DOT reserve frozen: ${await isFrozen()}`);

    // Bid over the dynamic-evm-fee base. Passing 0 here costs you the whole leg:
    // pallet_evm rejects it with GasPriceTooLow, the dispatcher still returns Ok,
    // and the referendum reports success while the reserve stays frozen.
    const baseFee = BigInt(await provider.send("eth_gasPrice", []));
    const maxFeePerGas = (baseFee * 4n).toString();
    console.log(`  gas price     ${baseFee} wei, bidding ${maxFeePerGas}`);

    const freezeCall = (freeze) =>
      api.tx.dispatcher.dispatchAsAaveManager(
        api.tx.evm.call(AAVE_MANAGER_EVM, configurator, CONFIGURATOR_ABI.encodeFunctionData("setReserveFreeze", [dotAddr, freeze]), 0, EVM_CALL_GAS, maxFeePerGas, null, null, [], [])
      );

    if (refreeze) {
      if (await isFrozen()) return console.log("  already frozen — nothing to do");
      await rootReferendum(api, signer, freezeCall(true), async () => await isFrozen());
      return console.log("\n  DOT reserve re-frozen.");
    }

    const dotDec = 10n;
    const mintDot = BigInt(env("MINT_DOT", "56000")) * 10n ** dotDec;
    const fundHollar = BigInt(env("FUND_HOLLAR", "51000")) * 10n ** 18n;
    const dest = truncatedAccountId(wallet.address);

    const erc = (a) => new ethers.Contract(a, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], wallet);
    const dotBal = () => erc(dotAddr).balanceOf(wallet.address);
    const holBal = () => erc(hollarAddr).balanceOf(wallet.address);

    console.log(`\n  minting ${mintDot / 10n ** dotDec} DOT + moving ${fundHollar / 10n ** 18n} HOLLAR, and unfreezing the reserve`);

    // Idempotent: currencies.updateBalance takes a signed DELTA, so re-running a
    // partially-applied batch would mint a second tranche. Only include the legs
    // that are actually still outstanding.
    const startDot = await dotBal();
    const startHol = await holBal();
    const needDot = startDot < mintDot;
    const needHol = startHol < fundHollar;
    const needThaw = await isFrozen();

    const calls = [];
    if (needThaw) calls.push(freezeCall(false));
    if (needDot) calls.push(api.tx.currencies.updateBalance(dest, DOT_ID, (mintDot - startDot).toString()));
    if (needHol)
      calls.push(
        api.tx.dispatcher.dispatchAsTreasury(
          api.tx.evm.call(TREASURY_EVM, hollarAddr, ERC20_ABI.encodeFunctionData("transfer", [wallet.address, (fundHollar - startHol).toString()]), 0, EVM_CALL_GAS, maxFeePerGas, null, null, [], [])
        )
      );

    console.log(`  legs: unfreeze=${needThaw} mintDot=${needDot} moveHollar=${needHol}`);
    if (calls.length === 0) console.log("  nothing to do — already funded and unfrozen");
    else
      await rootReferendum(api, signer, calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls), async () => {
        return !(await isFrozen()) && (await dotBal()) >= mintDot && (await holBal()) >= fundHollar;
      });

    console.log(`\n  DOT    ${ethers.formatUnits(await dotBal(), 10)}`);
    console.log(`  HOLLAR ${ethers.formatUnits(await holBal(), 18)}`);

    // --- supply DOT -> aDOT, as the deployer ---
    const supplyAmt = await dotBal();
    console.log(`\n  approving ${ethers.formatUnits(supplyAmt, 10)} DOT to the pool...`);
    const MAX_U128 = (1n << 128n) - 1n; // the asset precompile reads a u128 Balance
    await (await erc(dotAddr).approve(pool, MAX_U128, { gasLimit: 2_000_000 })).wait(2);

    const aavePool = new ethers.Contract(pool, ["function supply(address,uint256,address,uint16)"], wallet);
    const beforeADot = await erc(adotAddr).balanceOf(wallet.address);
    console.log(`  supplying...`);
    const tx = await aavePool.supply(dotAddr, supplyAmt, wallet.address, 0, { gasLimit: 5_000_000 });
    console.log(`  tx ${tx.hash}`);
    await tx.wait(2);
    const afterADot = await erc(adotAddr).balanceOf(wallet.address);

    console.log(`\n=== done ===`);
    console.log(`  aDOT   ${ethers.formatUnits(beforeADot, 10)} -> ${ethers.formatUnits(afterADot, 10)}  (+${ethers.formatUnits(afterADot - beforeADot, 10)})`);
    console.log(`  HOLLAR ${ethers.formatUnits(await holBal(), 18)}`);
    console.log(`\n  Re-freeze the reserve when you are done: node 11-mint-adot.js --refreeze`);
  } finally {
    await api.disconnect();
  }
}

main().catch((e) => {
  console.error(`\n  11-mint-adot FAILED: ${e.message}\n`);
  process.exit(1);
});
