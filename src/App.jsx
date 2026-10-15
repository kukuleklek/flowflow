import { Navigate, Route, Routes } from "react-router-dom";
import AppShell from "./layout/AppShell.jsx";
import MarketsPage from "./trade/MarketsPage.jsx";
import MarketPage from "./trade/MarketPage.jsx";
import AgentPage from "./agent/AgentPage.jsx";
import WalletPage from "./wallet/WalletPage.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/trade" replace />} />
        <Route path="/trade" element={<MarketsPage />} />
        <Route path="/trade/:coin" element={<MarketPage />} />
        <Route path="/agent" element={<AgentPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="*" element={<Navigate to="/trade" replace />} />
      </Route>
    </Routes>
  );
}
