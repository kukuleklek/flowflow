import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "./layout/AppShell.jsx";
import MarketsPage from "./trade/MarketsPage.jsx";
import MarketPage from "./trade/MarketPage.jsx";
import AgentPage from "./agent/AgentPage.jsx";
import WalletPage from "./wallet/WalletPage.jsx";
import { WELCOME_DESKTOP_MIN } from "./auth/welcomeView.js";

/** Phones open "/" on the markets list; desktop opens a coin terminal (owner, 2026-10-16). */
const isDesktop = () => { try { return window.matchMedia(`(min-width: ${WELCOME_DESKTOP_MIN}px)`).matches; } catch { return true; } };

/** "/" opens a coin terminal: BTC, or the coin a shared link names (/?coin=ETH), keeping the rest of the query.
 *  On a phone without ?coin= it opens /home instead. */
function Landing() {
  const { search } = useLocation();
  const q = new URLSearchParams(search);
  const coin = (q.get("coin") || "").trim();
  q.delete("coin");
  const rest = q.toString();
  if (!coin && !isDesktop()) return <Navigate to={{ pathname: "/home", search: rest ? `?${rest}` : "" }} replace />;
  return <Navigate to={{ pathname: `/trade/${encodeURIComponent(coin && coin.length <= 32 ? coin : "BTC")}`, search: rest ? `?${rest}` : "" }} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* First visit lands on the BTC terminal; the markets list lives at /home (owner, 2026-10-15). */}
        <Route index element={<Landing />} />
        <Route path="/home" element={<MarketsPage />} />
        <Route path="/trade" element={<Navigate to="/home" replace />} />
        <Route path="/trade/:coin" element={<MarketPage />} />
        <Route path="/agent" element={<AgentPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="*" element={<Navigate to="/trade/BTC" replace />} />
      </Route>
    </Routes>
  );
}
