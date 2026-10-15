// Deploys FlowFlowAccountFactory on Avalanche C-Chain. The deployer is admin and, unless RECORDER is set, the recorder.
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const [me] = await hre.ethers.getSigners();
  if (!me) throw new Error("No DEPLOYER_KEY in contracts/.env: run `npm run wallet` first.");
  const net = await hre.ethers.provider.getNetwork();
  const bal = await hre.ethers.provider.getBalance(me.address);
  console.log(`chain ${net.chainId} · deployer ${me.address} · ${hre.ethers.formatEther(bal)} AVAX`);
  const recorder = process.env.RECORDER || me.address;
  const F = await hre.ethers.getContractFactory("FlowFlowAccountFactory");
  const f = await F.deploy(recorder);
  await f.waitForDeployment();
  const address = await f.getAddress();
  const tx = f.deploymentTransaction();
  console.log(`FlowFlowAccountFactory: ${address}\ntx: ${tx && tx.hash}\nhttps://snowtrace.io/address/${address}`);
  fs.writeFileSync(path.join(__dirname, "..", "deployed.json"), `${JSON.stringify({ chainId: Number(net.chainId), address, recorder, tx: tx && tx.hash }, null, 2)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
