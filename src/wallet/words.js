// The customer's words for sentences the Wallet draws from modules it does not own (the deposit plan's rules and
// move line, the withdraw steps' errors and cautions, the balance notes).
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-15: "อย่าเรียก Perp Account … ลูกค้าไม่ต้องรู้หรอกว่า อะไรมันแยกกัน", "Hyperliquid เรียกว่า Main Account".
// The customer sees ONE balance (owner: "Balance … มันต้องรวมกันไปเลย"; wallet/portfolio.js). Until the modules that
// write these sentences say so themselves, this turns their "Perp account / wallet / balance" into "your balance" at
// the moment the Wallet draws them. Presentation only: the sentence keeps its meaning, a money warning stays a money
// warning, and a sentence already in the customer's words passes through unchanged. A network the customer must act
// on (gas on that network, "Send only USDC on Base") is never touched.

const RULES = [
  [/\byour Perp (?:account|wallet|balance)\b/g, "your balance"],
  [/\bthe Perp (?:account|wallet|balance)\b/g, "the balance"],
  [/\bPerp (?:account|wallet|balance)\b/g, "balance"],
  [/\byour (?:Main|Spot) Account balance\b/g, "your balance"],
  [/\byour (?:Main|Spot) Account\b/g, "your balance"],
  [/\byour Perp USDC\b/g, "your USDC"],
  [/\binto Perp\b/g, "into your balance"],
  [/\bfrom Perp\b/g, "from your balance"],
  [/\bin Perp\b/g, "in your balance"],
  /* The first deposit's last hop, said as where it is going rather than which chain holds it for a minute. */
  [/\bis in your own wallet on Arbitrum\./g, "is ready to join your balance."],
  [/\bUSDC in Spot, not used for perps\./g, "USDC here is not in use for trading yet."],
  /* Hyperliquid's own words for the one-time activation fee (taken on an account's first outbound transfer). */
  [/Insufficient USDC balance for token transfer gas\.?/gi, "Leave 1 USDC in your balance: Hyperliquid takes a one-time 1 USDC activation on your first withdrawal. Nothing was sent."],
];

/** The same sentence in the customer's words. Anything that is not a string comes back as it was. */
export function customerWords(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

export default customerWords;
