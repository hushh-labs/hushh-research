import React from "react";
import { createRoot } from "react-dom/client";

import { WalletWorkspace } from "../../components/wallet/wallet-workspace";

createRoot(document.getElementById("root")!).render(<WalletWorkspace />);
