import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { WalletProvider } from "./context/WalletContext.jsx";
import { BackendProvider } from "./perp/BackendContext.jsx";
import PrivyGate from "./components/privy/PrivyGate.jsx";
import { ToastHost } from "./ui/toast.jsx";
import DepositAutoMover from "./perp/deposit/AutoMover.jsx";
import DepositStatus from "./perp/deposit/DepositStatus.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <BackendProvider>
          <App />
          <ToastHost />
          {/* A deposit's last hop, made by itself wherever the customer is, and the one box that says where it is. */}
          <DepositAutoMover />
          <DepositStatus />
        </BackendProvider>
      </WalletProvider>
    </BrowserRouter>
    {/* A sibling of the app: no app component depends on a Privy context (services/privy is the bridge). */}
    <PrivyGate />
  </React.StrictMode>,
);
