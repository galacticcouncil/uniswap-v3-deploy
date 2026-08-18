/**
 * 04-owner-ops.js — factory-owner operations. If the configured key IS the
 * factory owner, the tx is sent; otherwise the raw {to, data} calldata is
 * printed for wrapping in a governance evm.call from the owner account.
 *
 *   node 04-owner-ops.js set-fee-protocol <pool> [n0] [n1] # n = 0 or 4..10 (fee = 1/n; 4 = 25%)
 *       n0/n1 default to FEE_PROTOCOL (launch value: 4 = 1/4, the maximum)
 *   node 04-owner-ops.js collect-protocol <pool> <recipient>
 *   node 04-owner-ops.js enable-fee-tier <fee> <tickSpacing> # e.g. 100 1
 *   node 04-owner-ops.js transfer-owner <newOwner>           # governance handoff
 */

const { ethers } = require("ethers");
const { env, requireEnv, ABI, loadDeployments } = require("./lib");

const MAX_UINT128 = (1n << 128n) - 1n;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const d = loadDeployments(env("NET", "mainnet"));
  const provider = new ethers.JsonRpcProvider(env("EVM_RPC_URL", d.network.evmRpc));
  const wallet = new ethers.Wallet(requireEnv("DEPLOYER_PK"), provider);
  const factory = new ethers.Contract(d.uniswap.v3CoreFactory, ABI.factory, wallet);
  const owner = await factory.owner();
  const isOwner = owner.toLowerCase() === wallet.address.toLowerCase();

  const poolIface = new ethers.Interface(ABI.pool);
  const factoryIface = new ethers.Interface(ABI.factory);

  let to, data, desc;
  switch (cmd) {
    case "set-fee-protocol": {
      // The protocol fee is a DENOMINATOR: bigger number = smaller fee, 4 = 1/4 is
      // the contract maximum. Default both sides to FEE_PROTOCOL so the launch
      // value is configuration, not something an operator retypes at the console.
      const pool = args[0];
      const dflt = env("FEE_PROTOCOL", "4");
      const [n0, n1] = [Number(args[1] ?? dflt), Number(args[2] ?? args[1] ?? dflt)];
      if (!ethers.isAddress(pool)) throw new Error("usage: set-fee-protocol <pool> [n0] [n1]");
      for (const n of [n0, n1]) {
        if (!Number.isInteger(n) || !(n === 0 || (n >= 4 && n <= 10))) {
          throw new Error("feeProtocol must be 0 or 4..10 (fee = 1/n)");
        }
      }
      if (n0 === 0 || n1 === 0) {
        console.log("  ! feeProtocol 0 = fee OFF. Launch config is 4 4 (1/4, the maximum).");
      }
      [to, data] = [pool, poolIface.encodeFunctionData("setFeeProtocol", [n0, n1])];
      desc = `setFeeProtocol(${n0}, ${n1}) on ${pool} — ${n0 ? `1/${n0}` : "0"} of swap fees to protocol`;
      break;
    }
    case "collect-protocol": {
      const [pool, recipient] = args;
      if (!ethers.isAddress(recipient)) throw new Error("bad recipient");
      [to, data] = [pool, poolIface.encodeFunctionData("collectProtocol", [recipient, MAX_UINT128, MAX_UINT128])];
      desc = `collectProtocol -> ${recipient} on ${pool}`;
      break;
    }
    case "enable-fee-tier": {
      const [fee, spacing] = [Number(args[0]), Number(args[1])];
      if (!fee || !spacing) throw new Error("usage: enable-fee-tier <fee> <tickSpacing>");
      [to, data] = [d.uniswap.v3CoreFactory, factoryIface.encodeFunctionData("enableFeeAmount", [fee, spacing])];
      desc = `enableFeeAmount(${fee}, ${spacing})`;
      break;
    }
    case "transfer-owner": {
      const [newOwner] = args;
      if (!ethers.isAddress(newOwner)) throw new Error("bad newOwner");
      [to, data] = [d.uniswap.v3CoreFactory, factoryIface.encodeFunctionData("setOwner", [newOwner])];
      desc = `factory.setOwner(${newOwner})`;
      break;
    }
    default:
      console.error("usage: node 04-owner-ops.js <set-fee-protocol|collect-protocol|enable-fee-tier|transfer-owner> ...");
      process.exit(1);
  }

  console.log(`  op:     ${desc}`);
  console.log(`  owner:  ${owner}${isOwner ? " (this key)" : ""}`);
  if (isOwner) {
    const tx = await wallet.sendTransaction({ to, data });
    console.log(`  tx:     ${tx.hash}`);
    await tx.wait();
    console.log("  done");
  } else {
    console.log("  this key is NOT the factory owner — wrap in a governance evm.call from the owner:");
    console.log(`  to:   ${to}`);
    console.log(`  data: ${data}`);
  }
}

main().catch((e) => {
  console.error("\n  owner-ops FAILED:", e.message, "\n");
  process.exit(1);
});
