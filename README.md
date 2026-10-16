<p align="center">
  <img src="public/icons/icon-192.png" width="72" alt="FlowFlow" />
</p>

<h1 align="center">FlowFlow</h1>
<p align="center"><b>Perp DEX trading. Trade, swap and stake by chat or voice.</b><br/>
Built on Avalanche and U.Bot Brain. Every order waits for your confirm.</p>

<p align="center"><a href="https://flowflow-alpha.vercel.app">flowflow-alpha.vercel.app</a></p>
<p align="center">Conceived and built entirely by <b>U.Bot</b>.</p>

---

## What it does

| | |
|---|---|
| **Trade by chat or voice** | "Long NVDA 10 USDC, max loss $3" → a plan card with entry, TP, SL and R:R computed in code → a final chart with the lines → one tap to open. Voice runs on OpenAI Realtime with the same tools and caps. |
| **Crypto + US stocks** | Every Hyperliquid perp, plus whitelisted HIP-3 stock perps (TSLA, NVDA, AAPL, S&P 500 …). Stock margin moves in and out automatically. |
| **Analyze with Tokenomist** | Trend on 1h / 4h / 1d, flip levels, risks, suggested R:R, and token unlocks / emission from Tokenomist. |
| **Deposit from Avalanche, Base & more** | USDC from Avalanche, Base, Arbitrum, Polygon, Ethereum, Optimism, BNB via Relay, landing in your Hyperliquid account. |
| **Private deposit & withdraw** | A Normal / Private toggle powered by NEAR Intents (one-time deposit address, four chains). |
| **Earn on idle USDC** | The Spot Account on Avalanche: stake USDC on Aave V3, swap whitelisted assets, move funds Main ↔ Spot — every signature in a visible Privy window. |

## Safety model

- **Your wallet, your money.** Privy embedded wallet (one EOA on every chain). Funds only move to your own address, except a withdrawal you type yourself.
- **Every money action is a card you confirm.** The Agent never signs; caps live in code (20 USDC margin per order, Agent ≤ 10x).
- **No silent money signatures.** The only no-window signatures are Hyperliquid's "enable trading" approvals and one first-deposit bridge transfer; everything else opens Privy's window, and each request is rebuilt and compared before Privy is asked.
- **Keys stay on the server.** LLM, Relay, Tokenomist and NEAR keys are server-only (`api/*`), never `VITE_`.

## Business model

**6 bps** of trading fee on volume routed through FlowFlow.

## Smart contract

`FlowFlowAccountFactory` on Avalanche C-Chain: [`0x5A0Fc6619ae64EdAf6971b8313c8265Eb8223a5d`](https://snowtrace.io/address/0x5A0Fc6619ae64EdAf6971b8313c8265Eb8223a5d#code)

- Source verified on Snowtrace (green check on the Contract tab, Read / Write Contract open), compiled with Solidity v0.8.24.
- Constructor argument: the recorder `0x05Da3c74bFC2f0a9Da172C23bAA4AacF02C17708`.
- Source: [`contracts/src/FlowFlowAccounts.sol`](contracts/src/FlowFlowAccounts.sol), deployment record: [`contracts/deployed.json`](contracts/deployed.json).

## Stack

Vite + React 18 · Tailwind · Privy · Hyperliquid (perps + HIP-3) · Relay · Avalanche (Aave V3) · NEAR Intents 1Click · Tokenomist · OpenAI (chat + Realtime voice) · Vercel functions.

```
src/agent        chat + voice agent: intents, plans, cards, analysis
src/lib          hyperliquid (signing, orders, HIP-3), relay, avax, intents, tokenomist
src/avax         Spot Account money flows (registry, signers, watcher)
src/wallet       Home, Wallet, Deposit / Withdraw panels
api/             serverless: chat, realtime-session, relay-quote, tokenomist, intents-*
contracts/       FlowFlowAccountFactory (Solidity 0.8.24, Hardhat)
scripts/         node --test suites (1,600+ tests, no network)
```

## Run locally

```bash
npm install
cp .env.example .env.local     # fill in what you need
npm run dev                    # http://localhost:5173
npm test
npm run build
```

`VITE_PERP_BACKEND=mock` runs on real mainnet prices with a simulated $1,000 account and never sends an order.
Key env (server-only): `LLM_*`, `OPENAI_API_KEY`, `RELAY_API_KEY`, `TOKENOMIST_API_KEY`, `PRIVATE_MODE`, `NEAR_INTENTS_JWT`. See `.env.example`.

Built for a hackathon on mainnet. FlowFlow is U.Bot's idea, and U.Bot built all of it.
