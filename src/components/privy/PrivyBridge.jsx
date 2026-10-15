import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePrivy, useLogin, useLogout, useWallets, useSignTypedData, useSendTransaction } from "@privy-io/react-auth";

import { registerPrivyApi, privyChainId } from "../../services/privy.js";
import {
  takeSignWords, signMessageUiOptions, sendTransactionUiOptions,
  SIGN_WORDS_TYPED_DATA, SIGN_WORDS_TRANSACTION,
} from "../../services/signWords.js";
import { PERP_ENABLED } from "../../lib/perpFlag.js";
import { avaxTxFromRequest, avaxTypedDataFromRequest, AvaxSignRefused } from "../../avax/closedTx.js";
import { recoverTypedDataFromRequest, RecoverSignRefused } from "../../lib/relay/recoverClosed.js";
import { provideRecoverSigner } from "../../lib/relay/recoverStranded.js";

/* The Avax Wallet's two closed builders (src/avax/closedTx.js), exported from
   here because this is where they gate Privy: what the VISIBLE Avalanche pair
   below asks Privy for is what they build, and nothing else. They are pure, and
   src/avax/signers.js runs the very same two before the request ever gets here. */
export { avaxTxFromRequest, avaxTypedDataFromRequest };
/* Recover's closed builder (lib/relay/recoverClosed.js), for the same reason:
   the VISIBLE Base / Polygon signer below asks Privy for what it builds. */
export { recoverTypedDataFromRequest };

/* NO KEY EXPORT. A useExportWallet() hook was registered here for the Perp
   mode and reached the Perp wallet strip as its own entry there. The owner
   removed the feature on 2026-09-23 ("อี Export Private Key ไม่ต้องมีหรอกก"), so
   the hook, the api.exportWallet it registered and the strip's entry are all
   gone. @privy-io/react-auth still exports useExportWallet; this app no longer
   calls it. */

/* PERP MODE ONLY: Enable trading with NO window. Owner (2026-09-22): "ต้องเซ็น
   Enable Trading ด้วยหรอวะ". The embedded wallet signs Hyperliquid's two
   Enable trading approvals through Privy's useSignTypedData with
   uiOptions.showWalletUIs false, so a Privy user never sees a signature
   request for them (exchange/master.js decides when; client.js runs it by
   itself on the first trade). Nothing else may be signed this way: the request
   is REBUILT here by one of the two builders below and Privy is asked to sign
   what they built, so a request that is not one of them is refused before
   Privy is asked at all. A withdrawal keeps its window (it goes
   through the wallet's provider, like every other signature), and so does key
   export (Privy's own modal above). Chosen once per build, like the export
   hook; with the Perp mode off nothing is registered. */
const useSilentSignForPerp = PERP_ENABLED ? useSignTypedData : () => null;
const useSilentSendForPerp = PERP_ENABLED ? useSendTransaction : () => null;
const SILENT_DOMAIN = "HyperliquidSignTransaction";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
];

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isChain = (s) => s === "Mainnet" || s === "Testnet";
const isNonce = (n) => Number.isSafeInteger(n) && n > 0;
/* THE AGENT NAME THIS APP ASKS FOR, AS A SHAPE — never a magic length. The
   producer is the exchange layer's agentStore: HL_AGENT_NAME, the word
   valid_until, and the key's expiry in epoch milliseconds, which is 34
   characters and so was refused by the 32 this once capped — every real
   approveAgent fell through to the window it is meant to avoid. The shape is
   checked instead, so the name signed with no window is the one this app
   produces and a longer expiry cannot silently break it. Written out here
   rather than imported: agentStore is Perp-only and must not reach a flag-off
   build. */
const isAgentName = (s) => typeof s === "string" && /^flowflow valid_until [0-9]{10,16}$/.test(s);

/* THE WHOLE LIST OF WHAT MAY BE SIGNED WITH NO WINDOW, as BUILDERS rather than
   as a filter. Each one owns its field list and checks every value; a request
   is answered by SIGNING WHAT THIS BUILDS, never what the caller handed in, so
   a domain, a type list or an extra field that is not below cannot reach
   Privy at all. Both are Enable trading's approvals — the approvals a user
   should not have to see a window for, because they authorise a key that can
   only trade (agentStore.js) and a fee that is already printed on the ticket.
   Moving money is NOT here and never will be: a withdrawal keeps its window. */
const SILENT_APPROVALS = {
  "HyperliquidTransaction:ApproveAgent": {
    fields: [
      { name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" },
      { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" },
    ],
    read: (m) => (isChain(m.hyperliquidChain) && isAddress(m.agentAddress)
      && isAgentName(m.agentName) && isNonce(m.nonce)
      ? { hyperliquidChain: m.hyperliquidChain, agentAddress: m.agentAddress, agentName: m.agentName, nonce: m.nonce }
      : null),
  },
  "HyperliquidTransaction:ApproveBuilderFee": {
    fields: [
      { name: "hyperliquidChain", type: "string" }, { name: "maxFeeRate", type: "string" },
      { name: "builder", type: "address" }, { name: "nonce", type: "uint64" },
    ],
    read: (m) => (isChain(m.hyperliquidChain) && typeof m.maxFeeRate === "string" && /^\d+(\.\d+)?%$/.test(m.maxFeeRate)
      && isAddress(m.builder) && isNonce(m.nonce)
      ? { hyperliquidChain: m.hyperliquidChain, maxFeeRate: m.maxFeeRate, builder: m.builder, nonce: m.nonce }
      : null),
  },
};

/**
 * The typed data one of the two builders above makes from a request, or null
 * when the request is not one of them. The domain is fixed except for the chain
 * id, which must be the action's own signatureChainId.
 */
export function silentApprovalTypedData(request) {
  if (!request || typeof request !== "object") return null;
  const { domain, primaryType, message } = request;
  const builder = primaryType && Object.prototype.hasOwnProperty.call(SILENT_APPROVALS, primaryType) ? SILENT_APPROVALS[primaryType] : null;
  if (!builder || !message || typeof message !== "object") return null;
  if (!domain || domain.name !== SILENT_DOMAIN || domain.version !== "1") return null;
  if (String(domain.verifyingContract).toLowerCase() !== ZERO_ADDRESS) return null;
  const chainId = Number(domain.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  /* The action carries the chain it was built for; it must be this domain's. */
  if (typeof message.signatureChainId === "string" && Number(message.signatureChainId) !== chainId) return null;
  const fields = builder.read(message);
  if (!fields) return null;
  return {
    domain: { name: SILENT_DOMAIN, version: "1", chainId, verifyingContract: ZERO_ADDRESS },
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, [primaryType]: builder.fields },
    primaryType,
    message: fields,
  };
}

/* PERP MODE ONLY: THE LAST HOP OF A FIRST DEPOSIT, with no window either.
   Owner (2026-09-27): "ครั้งแรก เกือบ noo fee". A deposit credited straight into a
   brand-new Perp account is charged a one-time cost (measured 1.245194 USDC on
   25 from Base); a plain USDC transfer into the venue's own deposit contract is
   charged nothing. So a first deposit is routed to the customer's OWN address on
   Arbitrum with a little gas beside it, and the embedded wallet makes that one
   transfer itself, paid for with the delivered gas
   (src/lib/relay/firstDeposit.js and arbitrumBridge.js decide when, and
   perp/deposit/useFirstDeposit.js asks).

   🔴 IT IS ONE TRANSACTION, AND IT IS REBUILT HERE. The values below are written
   out rather than imported, for the same reason the agent-name shape above is:
   the Perp deposit modules must not be pulled into this chunk, and a flag-off
   build must carry none of it. The authority for every one of them is
   src/lib/relay/arbitrumBridge.js, and a test compares the two so they
   cannot drift. Nothing else can pass: a transfer to any other address, of any
   other token, on any other chain, below the floor, or carrying native value is
   refused before Privy is asked at all. Moving money OUT is still not here — a
   withdrawal keeps its window. */
const PERP_FUNDING = Object.freeze({
  chainId: 42161,
  /* Native USDC on Arbitrum. */
  token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  /* The venue's own deposit contract: a transfer to it credits the sender. */
  recipient: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
  /* transfer(address,uint256) */
  selector: "0xa9059cbb",
  /* 🔴 Below this the transfer is accepted by the token, never credited by the
     venue, and gone: 5 USDC, in 6-decimal base units. */
  minRaw: 5000000n,
});

/**
 * The transfer this bridge will send with no window, REBUILT from the request's
 * own numbers, or null when the request is not that transfer. The amount is the
 * only thing the caller gets to choose, and it must clear the floor.
 */
export function perpFundingTx(request) {
  if (!request || typeof request !== "object") return null;
  if (Number(request.chainId) !== PERP_FUNDING.chainId) return null;
  if (String(request.to).toLowerCase() !== PERP_FUNDING.token) return null;
  if (request.value != null && !/^(0x)?0+$/.test(String(request.value))) return null;
  const data = typeof request.data === "string" ? request.data.toLowerCase() : "";
  if (!/^0x[0-9a-f]{136}$/.test(data) || !data.startsWith(PERP_FUNDING.selector)) return null;
  if (`0x${data.slice(34, 74)}` !== PERP_FUNDING.recipient) return null;
  if (!/^0+$/.test(data.slice(10, 34))) return null;
  let amount = 0n;
  try { amount = BigInt(`0x${data.slice(74)}`); } catch { return null; }
  if (amount < PERP_FUNDING.minRaw) return null;
  return {
    chainId: PERP_FUNDING.chainId,
    to: PERP_FUNDING.token,
    data: `${PERP_FUNDING.selector}${PERP_FUNDING.recipient.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
    value: "0x0",
  };
}

/* ── THE WINDOW STAYS, AND IT LEARNS TO TALK ────────────────────────────────
   Owner (2026-09-30): "ไม่ต้องเซ็นเงียบ แต่ทำ popup ให้สวย". So this is the
   OTHER pair of functions — the visible one — and it is deliberately nothing
   like the pair above:

     the pair above     rebuilds the request from its own allowlist, and asks
                        Privy for NO window. Perp mode only. It can sign two
                        things and refuses everything else.
     the pair below     passes the request through EXACTLY as the wallet asked
                        for it, and asks Privy for a window that is ALWAYS
                        shown, carrying the words the pressed button already
                        said (services/signWords builds the options object and
                        owns that invariant).

   They share no name, no allowlist and no code path, and neither can become
   the other: the visible pair never touches silentApprovalTypedData or
   perpFundingTx, and the options object it hands Privy is built by a function
   that writes the visible flag in itself, last, every time. A money action
   cannot be made quiet from here — the only list that can do that is
   exchange/master.js's, it holds Enable trading's two approvals, and nothing
   in this section goes near it.

   WHERE IT SITS. The money paths all sign through the shared ethers signer
   WalletContext builds over this provider, which takes no words. So the words
   are read HERE, from the request itself, at the moment the wallet is asked.
   A request with no words armed is handed to the provider untouched — which is
   exactly what happened before this existed, so every path that does not ask
   for words is byte-for-byte what it was. An injected wallet, WalletConnect
   and the trading key never reach this function at all. */

/**
 * The typed data an `eth_signTypedData_v4` request carries, or null when the
 * request is not the plain two-parameter shape ethers and the recovery signer
 * send. A third RPC parameter (Privy's signatureOptions / caip2) means this is
 * not a request this seam understands, so it is passed through untouched.
 */
export function typedDataFromRequest(params) {
  if (!Array.isArray(params) || params.length < 2 || params.length > 3) return null;
  if (params.length === 3 && params[2] != null) return null;
  const raw = params[1];
  let td = raw;
  if (typeof raw === "string") {
    try { td = JSON.parse(raw); } catch { return null; }
  }
  if (!td || typeof td !== "object") return null;
  if (!td.domain || typeof td.domain !== "object") return null;
  if (!td.types || typeof td.types !== "object") return null;
  if (typeof td.primaryType !== "string" || !td.primaryType) return null;
  if (!td.message || typeof td.message !== "object") return null;
  return td;
}

/** The one transaction an `eth_sendTransaction` request carries, or null. */
export function transactionFromRequest(params) {
  if (!Array.isArray(params) || params.length !== 1) return null;
  const tx = params[0];
  return tx && typeof tx === "object" ? tx : null;
}

/**
 * The wallet's own provider, with the two signing methods carrying the words
 * the pressed button said. `readSeam()` gives the embedded wallet's address and
 * Privy's two hook functions, or nothing — and with nothing, or with no words
 * armed, or with a request shape this seam does not recognise, the provider is
 * asked exactly as it was asked before.
 *
 * 🔴 NO SECOND ATTEMPT. If Privy refuses or the customer declines, that error
 * is thrown as it stands. Falling back to the provider here would open a
 * SECOND window over money the customer has already said no to.
 */
export function providerWithSignWords(provider, readSeam) {
  if (!provider || typeof provider.request !== "function") return provider;
  const plain = (args) => provider.request(args);
  const request = async (args) => {
    const method = args && args.method;
    if (method !== SIGN_WORDS_TYPED_DATA && method !== SIGN_WORDS_TRANSACTION) return plain(args);
    const params = args && Array.isArray(args.params) ? args.params : null;
    const seam = typeof readSeam === "function" ? readSeam() : null;
    const own = seam && typeof seam.address === "string" && isAddress(seam.address) ? seam.address.toLowerCase() : null;
    if (method === SIGN_WORDS_TYPED_DATA) {
      const typedData = typedDataFromRequest(params);
      /* Consumed whether or not it fits: words that were not for this
         signature must not be left lying about for the next one. */
      const words = takeSignWords({ method, primaryType: typedData ? typedData.primaryType : null });
      const from = params && typeof params[0] === "string" ? params[0].toLowerCase() : null;
      if (!words || !typedData || !own || from !== own || !seam || typeof seam.signTypedData !== "function") return plain(args);
      const out = await seam.signTypedData(typedData, { address: seam.address, uiOptions: signMessageUiOptions(words) });
      return out && typeof out === "object" ? out.signature : out;
    }
    const tx = transactionFromRequest(params);
    const words = takeSignWords({ method });
    const from = tx && typeof tx.from === "string" ? tx.from.toLowerCase() : null;
    if (!words || !tx || !own || (from && from !== own) || !seam || typeof seam.sendTransaction !== "function") return plain(args);
    const out = await seam.sendTransaction(tx, { address: seam.address, uiOptions: sendTransactionUiOptions(words) });
    return out && typeof out === "object" ? out.hash : out;
  };
  /* Everything else is the provider's own: its events, its chain id, its other
     methods. Only `request` is ours, and only for those two methods. */
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === "request") return request;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `walletClientType` of Privy's own embedded wallet (vs a linked external one). */
const EMBEDDED_WALLET = "privy";

/**
 * Poll `getter` until it returns something truthy. Privy's `useWallets()` list
 * populates a tick or two AFTER `onComplete` fires (the wallet is created, then
 * the hook re-renders), so we can't read it synchronously.
 */
function waitFor(getter, { timeoutMs = 20000, gapMs = 120 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const value = getter();
      if (value) return resolve(value);
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error("Timed out waiting for the Privy embedded wallet"));
      }
      setTimeout(tick, gapMs);
    };
    tick();
  });
}

/**
 * PrivyBridge — renders nothing. Lives inside <PrivyProvider> and publishes an
 * imperative `connect()` / `logout()` into `services/privy` so the plain
 * (non-hook) `WalletContext.connect("privy")` can drive the login flow.
 *
 * See services/privy.js for why the bridge exists.
 */
export default function PrivyBridge() {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { logout } = useLogout();
  const silentHook = useSilentSignForPerp();
  const privySign = silentHook && typeof silentHook.signTypedData === "function" ? silentHook.signTypedData : undefined;
  const sendHook = useSilentSendForPerp();
  const privySend = sendHook && typeof sendHook.sendTransaction === "function" ? sendHook.sendTransaction : undefined;
  /* The VISIBLE pair, separately named and separately reachable from the two
     above. Not flag-gated: a Withdraw and a trade want their words in
     every build, and asking for words never asks for less than a window. */
  const shownSignHook = useSignTypedData();
  const shownSendHook = useSendTransaction();
  const embedded = wallets.find((w) => w.walletClientType === EMBEDDED_WALLET);
  const embeddedAddress = embedded && typeof embedded.address === "string" ? embedded.address : null;
  /* The no-window signature, as the bare 65-byte hex the signing SDK reads. */
  const signTypedDataSilently = useMemo(() => (privySign
    ? async (request, address) => {
      const typedData = silentApprovalTypedData(request);
      if (!typedData) throw new Error("Only Hyperliquid's Enable trading approvals can be signed silently.");
      const out = await privySign(typedData, { address, uiOptions: { showWalletUIs: false } });
      return out && typeof out === "object" ? out.signature : out;
    }
    : undefined), [privySign]);

  /* The no-window transfer, as the transaction hash it produced. The wallet does
     not leave its chain to do it: Privy reads the chain id off the request itself and
     builds its own client for that chain, so WalletContext's own chain (and its
     wrong-network pill) are untouched. */
  const sendPerpFunding = useMemo(() => (privySend
    ? async (request, address) => {
      const tx = perpFundingTx(request);
      if (!tx) throw new Error("Only a Perp account funding transfer can be sent with no window.");
      const out = await privySend(tx, { address, uiOptions: { showWalletUIs: false } });
      return out && typeof out === "object" ? out.hash : out;
    }
    : undefined), [privySend]);

  // Mirror hook state into refs so the `connect()` closure below always reads
  // CURRENT values while it's awaiting, instead of the render it was built in.
  const walletsRef = useRef(wallets);
  const authRef = useRef(authenticated);
  useEffect(() => { walletsRef.current = wallets; }, [wallets]);
  useEffect(() => { authRef.current = authenticated; }, [authenticated]);

  /* What the worded-window seam reads at signing time. A ref, so connect()'s
     closure keeps its identity and the OAuth-return eager mount is untouched;
     read fresh on every request, so a wallet that arrives a tick later is the
     one the words are carried to. Empty here simply means no words: the
     provider is then asked exactly as it was asked before. */
  const seamRef = useRef(null);
  useEffect(() => {
    seamRef.current = embeddedAddress
      && typeof shownSignHook?.signTypedData === "function"
      && typeof shownSendHook?.sendTransaction === "function"
      ? {
        address: embeddedAddress,
        signTypedData: shownSignHook.signTypedData,
        sendTransaction: shownSendHook.sendTransaction,
      }
      : null;
  }, [embeddedAddress, shownSignHook, shownSendHook]);

  /* ── THE AVAX WALLET: AVALANCHE, ALWAYS WITH A WINDOW ─────────────────────
     Owner, 2026-10-15: "ต่อปุ่ม Swap / Move / Stake ของ Avax เข้ากับการเซ็นจริงใน
     Privy เลย". The Avax Wallet is this same embedded EOA on chain 43114, and
     its Stake / Unstake / Swap / Move-out sign HERE — on the SHOWN pair above
     (shownSendHook, shownSignHook), with no new hook call, so a flag-off build
     still asks Privy for exactly two hooks (test-perp-silent-enable B3) and the
     silent pair stays the only no-window path (G1 counts it).

     🔴 WHAT PRIVY IS ASKED FOR IS WHAT THE CLOSED BUILDER BUILT. The request
     and the review it names go through avaxTxFromRequest /
     avaxTypedDataFromRequest; null is a refusal before Privy is asked, and the
     window carries the words THEY wrote from the decoded figures. The options
     come from services/signWords, which writes the window-shown flag in itself,
     last, every time.

     🔴 NEVER A CHAIN SWITCH. Privy reads chainId 43114 off the transaction and
     builds its own client for it (PrivyMount lists Avalanche, with our RPC);
     the wallet stays parked on Arbitrum, so the Main Account's signatures keep
     signatureChainId 0xa4b1 (exchange/client.js masterGate) and WalletContext's
     own chain is untouched. Typed data carries its own domain chainId. */
  const shownSend = shownSendHook && typeof shownSendHook.sendTransaction === "function" ? shownSendHook.sendTransaction : undefined;
  const shownSign = shownSignHook && typeof shownSignHook.signTypedData === "function" ? shownSignHook.signTypedData : undefined;
  /* Read at signing time, like seamRef: a hook function that is rebuilt on a
     render must not re-register the bridge (every registration wakes the
     app-wide subscribers) — the pair keeps its identity while the wallet does. */
  const shownRef = useRef({ send: shownSend, sign: shownSign });
  useEffect(() => { shownRef.current = { send: shownSend, sign: shownSign }; }, [shownSend, shownSign]);
  const shownReady = !!shownSend && !!shownSign;
  const avalanche = useMemo(() => {
    if (!embeddedAddress || !shownReady) return null;
    /** One Avalanche transaction, in a window; resolves its hash. */
    const sendTransaction = async (request, check) => {
      const built = avaxTxFromRequest(request, check, embeddedAddress);
      if (!built) throw new AvaxSignRefused("not-built", { at: "bridge", kind: check && check.kind });
      const send = shownRef.current.send;
      if (typeof send !== "function") throw new AvaxSignRefused("no-wallet", { at: "bridge" });
      const out = await send(built.tx, { address: embeddedAddress, uiOptions: sendTransactionUiOptions(built.words) });
      return out && typeof out === "object" ? out.hash : out;
    };
    /** One Avalanche typed-data signature (the move back to the Main Account), in a window. */
    const signTypedData = async (typedData, review) => {
      const built = avaxTypedDataFromRequest(typedData, review, embeddedAddress);
      if (!built) throw new AvaxSignRefused("not-built", { at: "bridge", kind: "typed-data" });
      const sign = shownRef.current.sign;
      if (typeof sign !== "function") throw new AvaxSignRefused("no-wallet", { at: "bridge" });
      const out = await sign(built.typedData, { address: embeddedAddress, uiOptions: signMessageUiOptions(built.words) });
      return out && typeof out === "object" ? out.signature : out;
    };
    return Object.freeze({ address: embeddedAddress, sendTransaction, signTypedData });
  }, [embeddedAddress, shownReady]);

  /* ── RECOVER: BASE AND POLYGON, ALWAYS WITH A WINDOW ──────────────────────
     Owner, 2026-10-15: "เอา ARB, Avax, Base, Polygon พอแระ". A private deposit's
     refund on Base or Polygon lands in this same embedded EOA, with no gas
     there, and the Deposit sheet's Recover row moves it into the balance with
     one typed-data signature (lib/relay/recoverStranded.js: EIP-3009 on that
     chain's USDC, and from 2026-10-26 a call authorization before it). It signs
     HERE, on the SHOWN sign hook above (shownRef), with no new hook call (B3),
     and nothing of it is on the silent pair (G1).

     🔴 WHAT PRIVY IS ASKED FOR IS WHAT THE CLOSED BUILDER BUILT.
     recoverTypedDataFromRequest rebuilds the request from the Recover review it
     names (that chain's native USDC, from this wallet, to Relay's pinned
     receiver, the reviewed amount, nonce and deadline); null is a refusal before
     Privy is asked, and the window carries the words it wrote from the decoded
     figures, through services/signWords (window shown, written last).

     🔴 NEVER A CHAIN SWITCH. Typed data carries its own domain chainId (8453 /
     137); Privy signs it while the wallet stays parked on Arbitrum, so the Main
     Account's signatureChainId and WalletContext's own chain are untouched. */
  const recover = useMemo(() => {
    if (!embeddedAddress || !shownReady) return null;
    /** One Recover typed-data signature, in a window; resolves the 65-byte hex. */
    const signTypedData = async (typedData, review) => {
      const built = recoverTypedDataFromRequest(typedData, review, embeddedAddress);
      if (!built) throw new RecoverSignRefused("not-built", { at: "bridge" });
      const sign = shownRef.current.sign;
      if (typeof sign !== "function") throw new RecoverSignRefused("no-wallet", { at: "bridge" });
      const out = await sign(built.typedData, { address: embeddedAddress, uiOptions: signMessageUiOptions(built.words) });
      return out && typeof out === "object" ? out.signature : out;
    };
    /* The wallet it signs for rides on the function, so the Recover row can say so before anyone presses. */
    return Object.freeze({ address: embeddedAddress, signTypedData: Object.freeze(Object.assign(signTypedData, { address: embeddedAddress })) });
  }, [embeddedAddress, shownReady]);

  /* Recover reads its signer from lib/relay/recoverStranded, only while a
     signed-in embedded wallet can sign; it is taken back when either goes. */
  useEffect(() => {
    if (!recover || !authenticated) return undefined;
    return provideRecoverSigner(recover.signTypedData);
  }, [recover, authenticated]);

  // `login()` is fire-and-forget (returns void) — Privy reports the outcome via
  // callbacks. Park a resolve/reject pair here so connect() can await it.
  const pendingLogin = useRef(null);
  const { login } = useLogin({
    onComplete: () => {
      pendingLogin.current?.resolve();
      pendingLogin.current = null;
    },
    onError: (code) => {
      // `exited_auth_flow` = user closed the modal. Everything else is a real
      // failure (bad app id, domain not allowlisted, network, ...).
      const err = new Error(
        code === "exited_auth_flow" ? "Login cancelled" : `Privy login failed (${code})`,
      );
      pendingLogin.current?.reject(err);
      pendingLogin.current = null;
    },
  });

  const connect = useCallback(async ({ silent = false, method, viaRedirect = false } = {}) => {
    if (!authRef.current) {
      if (viaRedirect) {
        // Returning from a full-page OAuth redirect (Google/Twitter): <PrivyProvider>
        // has just mounted on this fresh load and is finishing the ?privy_oauth_code
        // exchange in the background. WAIT for it to authenticate — do NOT call
        // login() here (that reopens the modal and bounces the user back to Google).
        // If the exchange fails, waitFor times out → a normal rejected connect.
        await waitFor(() => authRef.current, { timeoutMs: 20000 });
      } else {
        // Auto-reconnect on page load must never ambush the user with a modal.
        if (silent) throw new Error("PRIVY_NO_SESSION");
        await new Promise((resolve, reject) => {
          pendingLogin.current = { resolve, reject };
          // A specific method (passkey | twitter | email) opens Privy STRAIGHT to
          // that flow (no generic picker); omitted → the full method list.
          login(method ? { loginMethods: [method] } : undefined);
        });
      }
    }

    // `createOnLogin: users-without-wallets` guarantees the embedded wallet
    // exists by the time onComplete fires — but the hook list lags a tick.
    const wallet = await waitFor(() =>
      walletsRef.current.find((w) => w.walletClientType === EMBEDDED_WALLET),
    );

    // Park the wallet on its home chain before handing it over. Throws only if the chain
    // isn't in `supportedChains` (it is) or it's already there — either way the
    // provider is usable, and WalletContext's wrong-network pill is the backstop.
    try { await wallet.switchChain(privyChainId()); } catch { /* already on it */ }

    /* The same provider WalletContext has always been handed, with the two
       signing methods able to carry the pressed button's own words. With none
       armed it behaves exactly as the bare provider did. */
    return providerWithSignWords(await wallet.getEthereumProvider(), () => seamRef.current);
  }, [login]);

  useEffect(() => {
    const api = { ready, authenticated, connect, logout };
    if (signTypedDataSilently) {
      api.signTypedDataSilently = signTypedDataSilently;
      api.embeddedAddress = embeddedAddress;
    }
    if (sendPerpFunding) api.sendPerpFunding = sendPerpFunding;
    /* The visible Avalanche pair, only while there is a signed-in embedded wallet to sign with. */
    if (avalanche && authenticated) api.avalanche = avalanche;
    /* The visible Base / Polygon Recover signer, on the same terms. */
    if (recover && authenticated) api.recover = recover;
    registerPrivyApi(api);
  }, [ready, authenticated, connect, logout, signTypedDataSilently, sendPerpFunding, embeddedAddress, avalanche, recover]);

  return null;
}
