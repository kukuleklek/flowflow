/* Stake USDC as "USDC Staked AAVE" in the Spot Account, on AVAX (owner: "ในหน้า Avax Wallet มี Vault AAVE อยู่ ให้ Staking
   USDC"; two accounts: Main Account for trading, Spot Account for coins and USDC Staked AAVE). The APY, the two steps
   (move the USDC from the Main Account to the Spot Account, stake it), the AVAX kept for gas.

   While the Spot Account is not open in this build (VITE_EARN off, i.e. prod until the live test), the card says so
   plainly and offers what the reader can do now; it is never a dead end. When it is on, the card hands over to the
   Spot Account, where the plan is confirmed: this card itself never signs or moves anything. Logos: the USDC coin
   with the Avalanche badge (no Aave mark; the words say "AAVE").

   Card kind "stake": { asset: "USDC", amountUsdc|null, apyPct|null, protocol: "Aave V3", chain: "Avalanche",
   steps: [{ kind: "move", label }, { kind: "supply", label }], enabled, note } (protocol / chain are the data
   contract; the card draws them as "USDC Staked AAVE · on AVAX"). */
import Button from "../../ui/Button.jsx";
import Icon from "../../ui/Icon.jsx";
import Tip from "../../ui/Tip.jsx";
import LiveDot from "../../ui/LiveDot.jsx";
import { chat } from "../store.js";
import AssetLogo, { useAaveApy, apyText } from "./AssetLogo.jsx";
import { useChatActions, EARN_ON, PILL, Glyph } from "./ChatActions.jsx";

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const usdc = (v) => (fin(v) ? `${v.toFixed(2)} USDC` : "—");

const DEFAULT_STEPS = [
  { kind: "move", label: "Move USDC to your Spot Account" },
  { kind: "supply", label: "Stake as USDC Staked AAVE" },
];

/* Each step's mark: the USDC coin, with the Avalanche badge where the step lands in the Spot Account. */
function StepMark({ kind }) {
  return <AssetLogo coin="USDC" size={18} chain={kind === "supply" || kind === "move" ? "avalanche" : null} />;
}

/* The card's data says where (protocol "Aave V3", chain "Avalanche"); the customer reads the two-account words. */
const whereText = (protocol, chain) => `${/aave/i.test(protocol || "") ? "USDC Staked AAVE" : protocol} · ${/avalanche|avax/i.test(chain || "") || !chain ? "on AVAX" : `on ${chain}`}`;

function gasText(card) {
  const g = card && typeof card.gas === "object" && card.gas ? card.gas : {};
  const avax = fin(card.gasAvax) ? card.gasAvax : fin(g.avax) ? g.avax : null;
  const usd = fin(card.gasUsd) ? card.gasUsd : fin(g.usd) ? g.usd : null;
  if (avax == null) return null;
  return `≈ ${avax.toLocaleString("en-US", { maximumFractionDigits: 4 })} AVAX${usd != null ? ` (≈ $${usd.toFixed(2)})` : ""}`;
}

export default function StakeCard({ mid, card }) {
  const ctx = useChatActions();
  const live = useAaveApy();
  const cardApy = fin(card.apyPct) ? card.apyPct : null;
  const apy = cardApy != null ? cardApy : live.apyPct;
  const isLive = cardApy == null && live.apyPct != null;
  const steps = (Array.isArray(card.steps) && card.steps.length ? card.steps : DEFAULT_STEPS)
    .filter((s) => s && typeof s.label === "string").slice(0, 4);
  const enabled = card.enabled === true && EARN_ON;
  const amount = fin(card.amountUsdc) && card.amountUsdc > 0 ? card.amountUsdc : null;
  const gas = gasText(card);
  const note = typeof card.note === "string" ? card.note.trim() : "";
  /* While staking is not open the lock row below says so, once (review, polish 1: the Agent's line, this note and
     the lock row said "opens with the Spot Account" three times): the note keeps only what else it says (a cap, a
     paused reserve). */
  const shownNote = card.enabled === true && EARN_ON ? note : note.replace(/Opens with the Spot Account\b[^.]*\.(\s*Your USDC stays[^.]*\.)?/i, "").trim();
  const protocol = typeof card.protocol === "string" && card.protocol ? card.protocol : "Aave V3";

  if (card.status === "cancelled") {
    return (
      <div className="t-swap-in flex items-center gap-2.5 px-4 py-2.5">
        <Icon name="x" size={16} className="text-muted-foreground" />
        <AssetLogo coin="USDC" size={20} />
        <span className="text-sm font-medium">Stake USDC closed</span>
      </div>
    );
  }

  return (
    <div className="t-swap-in">
      <div className="flex items-center justify-between gap-3 px-4 pb-2.5 pt-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <AssetLogo coin="USDC" size={28} chain="avalanche" />
          <span className="min-w-0">
            <span className="block truncate text-h2">Stake {card.asset || "USDC"}</span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{whereText(protocol, card.chain)}</span>
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">Spot Account</span>
      </div>

      <div className="grid grid-cols-2 border-t border-hairline">
        <div className="min-w-0 px-4 py-3">
          <div className="text-label text-muted-foreground">APY</div>
          <div className={`num mt-1.5 text-[24px] font-medium leading-none tracking-[-0.03em] ${apy != null ? "text-success" : "text-foreground"}`}>{apyText(apy)}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {isLive ? <LiveDot /> : null}{isLive ? "Live · variable" : "Variable"}
            <Tip align="start" title="About the rate">The rate moves with demand for USDC on AAVE. It is not fixed and not promised.</Tip>
          </div>
        </div>
        <div className="min-w-0 border-l border-hairline px-4 py-3">
          <div className="text-label text-muted-foreground">You stake</div>
          <div className="num mt-1.5 text-[24px] font-medium leading-none tracking-[-0.03em]">{amount != null ? amount.toFixed(2) : "—"}</div>
          <div className="mt-1.5 text-xs text-muted-foreground">USDC{amount != null ? " from Main Account" : " · you choose"}</div>
        </div>
      </div>

      <ol className="border-t border-hairline px-4 py-2">
        {steps.map((s, i) => (
          <li key={`${s.kind}${i}`} className="flex min-h-8 items-center gap-2.5 py-0.5 text-xs">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground">{i + 1}</span>
            <span className="grid size-5 shrink-0 place-items-center"><StepMark kind={s.kind} /></span>
            <span className="min-w-0 leading-snug">{s.label.slice(0, 64)}</span>
          </li>
        ))}
        <li className="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-2 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            Gas for later
            <Tip title="About gas" align="start">
              Every step on AVAX needs a little AVAX for gas. When your Spot Account is low on AVAX, a small part of the
              move becomes AVAX and stays in your Spot Account, so you can always withdraw. It is shown here before you
              confirm.
            </Tip>
          </span>
          <span className="num font-medium">{gas || "Only if AVAX is low"}</span>
        </li>
      </ol>

      {shownNote ? (
        <p className="border-t border-hairline px-4 py-2.5 text-xs text-muted-foreground">{shownNote.slice(0, 160)}</p>
      ) : null}

      {enabled ? (
        <div className="grid grid-cols-[2fr_1fr] gap-2 border-t border-hairline px-4 pb-3 pt-2.5">
          <Button variant="primary" size="md" onClick={() => ctx && ctx.navigate(`/wallet?panel=earn${amount != null ? `&amount=${amount}` : ""}`)}>
            Review in Spot Account <Icon name="arrowUpRight" size={16} />
          </Button>
          <Button variant="outline" size="md" onClick={() => { chat.patchCard(mid, { status: "cancelled" }); chat.noteLlm("The user closed the stake card. Nothing was moved."); }}>Not now</Button>
        </div>
      ) : (
        <div className="border-t border-hairline px-4 pb-3 pt-2.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Glyph name="lock" size={12} /></span>
            <span className="min-w-0 text-xs">
              <span className="font-medium">Opens with the Spot Account soon</span>
              <span className="text-muted-foreground"> · your USDC stays in your Main Account until then.</span>
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button type="button" className={PILL} disabled={!ctx} onClick={() => ctx && ctx.navigate("/wallet?panel=deposit")}>
              <Icon name="plus" size={14} />Deposit USDC
            </button>
            <button type="button" className={PILL} disabled={!ctx || ctx.busy} onClick={() => ctx && ctx.send("Show me a setup")}>
              <Glyph name="layers" size={14} />Trade it instead
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
