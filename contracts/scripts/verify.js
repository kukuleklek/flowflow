// Verifies the deployed factory on Snowtrace (Routescan), from deployed.json.
const hre = require("hardhat");
const d = require("../deployed.json");

hre.run("verify:verify", { address: d.address, constructorArguments: [d.recorder], contract: "src/FlowFlowAccounts.sol:FlowFlowAccountFactory" })
  .then(() => console.log(`verified: https://snowtrace.io/address/${d.address}#code`))
  .catch((e) => { console.error(e.message || e); process.exit(1); });
