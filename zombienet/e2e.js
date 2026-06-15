/**
 * e2e.js  —  phase 1 orchestrator. Brings up an EVM-ready local zombienet and
 * deploys the full Uniswap v3 stack onto it. Leaves the chain running (Gamma's
 * phase 2 needs it).
 *
 *   node e2e.js          build spec -> spawn -> wait -> setup -> deploy
 *   node e2e.js stop     tear down the background zombienet
 */

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { build } = require("./chainspec");
const { setup } = require("./setup");
const { deploy } = require("./deploy");

const HYDRADX = process.env.HYDRADX || path.join(__dirname, "../../hydration-node/target/release/hydradx");
const POLKADOT = process.env.POLKADOT || path.join(__dirname, "../../polkadot-sdk/target/release/polkadot");
const RPC = process.env.EVM_RPC_URL || "http://127.0.0.1:9999";
const PIDFILE = path.join(__dirname, "zombienet.pid");
const LOG = path.join(__dirname, "zombienet.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollBlocks(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const j = await r.json();
      if (j.result && j.result !== "0x0") return j.result;
    } catch {
      /* RPC not up yet */
    }
    await sleep(5000);
  }
  throw new Error(`no blocks within ${timeoutMs / 1000}s — check ${LOG}`);
}

async function up() {
  console.log("=== Uniswap v3 on local zombienet — phase 1 ===");
  if (!fs.existsSync(HYDRADX)) throw new Error(`hydradx not built: ${HYDRADX} (cargo build --release)`);
  if (!fs.existsSync(POLKADOT)) throw new Error(`polkadot not built: ${POLKADOT}`);
  if (!fs.existsSync(path.join(__dirname, "node_modules"))) throw new Error(`run 'npm install' in ${__dirname}`);

  console.log("[1/4] Building chain spec...");
  build();

  console.log("[2/4] Spawning zombienet (background)...");
  const out = fs.openSync(LOG, "a");
  const child = spawn("zombienet", ["spawn", "zombienet.json"], {
    cwd: __dirname,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.on("error", (e) => console.error(`  zombienet spawn error: ${e.message}`));
  if (child.pid) fs.writeFileSync(PIDFILE, String(child.pid));
  child.unref();
  fs.closeSync(out);
  console.log(`  zombienet pid ${child.pid}, log: ${LOG}`);

  console.log(`  Waiting for block production on ${RPC} (up to 4 min)...`);
  const bn = await pollBlocks(240000);
  console.log(`  Block production started (eth_blockNumber=${bn}).`);

  console.log("[3/4] Chain setup (WETH location + fee currency)...");
  await setup();

  console.log("[4/4] Deploying Uniswap v3...");
  deploy();

  console.log("\n=== Phase 1 complete. Addresses: deployments/zombienet.json ===");
  console.log(`  Chain still running (pid ${child.pid}). Stop: node e2e.js stop`);
  console.log("  Next: deploy Gamma — see ../../gamma-hypervisor/zombienet/README.md");
}

function stop() {
  if (fs.existsSync(PIDFILE)) {
    const pid = parseInt(fs.readFileSync(PIDFILE, "utf8"), 10);
    console.log(`Killing zombienet pid ${pid}...`);
    try {
      process.kill(-pid, "SIGTERM"); // detached leader => kill the whole group
    } catch {
      /* gone */
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
    fs.rmSync(PIDFILE, { force: true });
  }
  try {
    execFileSync("pkill", ["-f", "zombienet spawn zombienet.json"]);
  } catch {
    /* nothing to reap */
  }
  console.log("Stopped. (If nodes linger: pkill -f hydradx ; pkill -f 'polkadot --')");
}

if (process.argv[2] === "stop") {
  stop();
} else {
  up()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("\n  E2E FAILED:", e.message, "\n");
      process.exit(1);
    });
}
