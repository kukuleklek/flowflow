// Makes the deployer / recorder key ONCE, into contracts/.env (gitignored). Prints the ADDRESS only, never the key.
const fs = require("node:fs");
const path = require("node:path");
const { Wallet } = require("ethers");

const file = path.join(__dirname, "..", ".env");
const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const m = /^DEPLOYER_KEY=(0x[0-9a-fA-F]{64})$/m.exec(text);
const w = m ? new Wallet(m[1]) : Wallet.createRandom();
if (!m) fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}DEPLOYER_KEY=${w.privateKey}\n`, { mode: 0o600 });
console.log(`${m ? "Existing" : "New"} deployer / recorder address: ${w.address}`);
console.log("Send about 0.05 AVAX (Avalanche C-Chain) to it. The key stays in contracts/.env only.");
