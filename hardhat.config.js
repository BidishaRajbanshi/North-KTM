require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();   // reads keys from the .env file (copy .env.example → .env)

// Only use the key if it looks real (the .env template ships with a blank "0x").
const PK = /^0x[0-9a-fA-F]{64}$/.test(process.env.MST_PRIVATE_KEY || "") ? process.env.MST_PRIVATE_KEY : null;

module.exports = {
  solidity: {
    version: "0.8.24",
    // "paris" avoids the PUSH0 opcode, which some PoSA/Parlia chains don't support yet.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    // Local practice chain: `npm run chain` starts it, no wallet or faucet needed.
    localhost: { url: "http://127.0.0.1:8545" },
    // Real MST testnet: needs MST_PRIVATE_KEY in .env, funded from the faucet.
    mstTestnet: {
      url: "https://testnetrpc.mstblockchain.com",
      chainId: 91562037,
      accounts: PK ? [PK] : [],
    },
  },
};
