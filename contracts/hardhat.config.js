// FlowFlow's Avalanche contract. Keys live in contracts/.env (gitignored): DEPLOYER_KEY, made by `npm run wallet`.
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

const key = process.env.DEPLOYER_KEY;

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" } },
  paths: { sources: "./src" },
  networks: {
    avalanche: {
      url: process.env.AVAX_RPC || "https://api.avax.network/ext/bc/C/rpc",
      chainId: 43114,
      accounts: key ? [key] : [],
    },
  },
  /* Snowtrace is Routescan's: no real key needed. */
  etherscan: {
    apiKey: { avalanche: "snowtrace" },
    customChains: [{
      network: "avalanche",
      chainId: 43114,
      urls: {
        apiURL: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan",
        browserURL: "https://snowtrace.io",
      },
    }],
  },
  sourcify: { enabled: false },
};
