// DEV ONLY (usePortfolio's ?ffPortfolioPreview=…): sample answers from Avalanche, Arbitrum and the deposit watch, laid
// over the real Perp figures, so the states a mock build cannot reach can be looked at and screenshotted. Only
// reached behind `import.meta.env.DEV`; a production build drops this file. No figure here is ever shown as real.

const asset = (symbol, decimals, amount, native = false) => {
  const raw = BigInt(Math.round(amount * 10 ** Math.min(decimals, 12))) * 10n ** BigInt(Math.max(0, decimals - 12));
  return { symbol, decimals, native, raw, amount };
};

const reserve = { apyPct: 5.7002, aprPct: 5.5436, active: true, frozen: false, paused: false };

function account({ usdc = 0, avax = 0, wavax = 0, btcb = 0, usdt = 0, xaut = 0, aave = 0 } = {}) {
  return {
    assets: [
      asset("USDC", 6, usdc), asset("AVAX", 18, avax, true), asset("WAVAX", 18, wavax),
      asset("BTC.b", 8, btcb), asset("USDT", 6, usdt), asset("XAUt0", 6, xaut),
    ],
    aave: { suppliedRaw: BigInt(Math.round(aave * 1e6)), suppliedUsdc: aave, status: reserve },
  };
}

const RELAY = { USDC: 0.9999, AVAX: 9.64, WAVAX: 9.64, "BTC.b": 81520, USDT: 1.0002, XAUt0: 4012.5 };

const onTheWay = [{ amount: 20, token: "USDC", from: "Base", to: "your Perp account", stage: "on its way" }];

export function previewInputs(kind, input) {
  const base = { ...input, mock: false, signedIn: true, settled: true, prices: { relay: RELAY, mids: { AVAX: 9.63, BTC: 81500, PAXG: 4015 } } };
  switch (kind) {
    case "loading":
      return { ...base, settled: false, avax: { status: "loading" }, arbitrum: { status: "loading" }, deposits: { onTheWay: [], problems: [], unread: "loading" }, flows: [] };
    case "partial":
      return {
        ...base,
        avax: { status: "failed", why: "Couldn't read Avalanche" },
        arbitrum: { status: "ok", wallet: { usdc: 0, waitingToMove: false, belowMinimum: false, minimumUsdc: 5, move: null } },
        deposits: { onTheWay: [], problems: [], unread: null },
        flows: [],
      };
    case "empty":
      return {
        ...base,
        avax: { status: "ok", account: account() },
        arbitrum: { status: "ok", wallet: { usdc: 0, waitingToMove: false, belowMinimum: false, minimumUsdc: 5, move: null } },
        deposits: { onTheWay: [], problems: [], unread: null },
        flows: [],
      };
    case "flight":
      return {
        ...base,
        avax: { status: "ok", account: account({ usdc: 120.5, avax: 0.84, aave: 250.12 }) },
        arbitrum: { status: "ok", wallet: { usdc: 0, waitingToMove: false, belowMinimum: false, minimumUsdc: 5, move: "moving", movingUsdc: 9.918 } },
        deposits: {
          onTheWay,
          problems: [{ amount: 3, token: "USDC", from: "Polygon", stage: "sent back to where it came from" }],
          unread: null,
        },
        flows: [
          { id: "flow-stake-1", kind: "stake", state: "arriving", amounts: { usdc: "50" } },
          { id: "flow-swap-1", kind: "swap", state: "unknown", amounts: { fromAmount: "0.5", from: "AVAX" } },
        ],
      };
    case "full":
    default:
      return {
        ...base,
        avax: { status: "ok", account: account({ usdc: 120.5, avax: 2.1234, btcb: 0.000123, xaut: 0.01, aave: 250.12 }) },
        arbitrum: { status: "ok", wallet: { usdc: 9.918, waitingToMove: true, belowMinimum: false, minimumUsdc: 5, move: "by-itself" } },
        deposits: { onTheWay, problems: [], unread: null },
        flows: [],
      };
  }
}
