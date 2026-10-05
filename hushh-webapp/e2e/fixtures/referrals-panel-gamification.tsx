import { createRoot } from "react-dom/client";
import { ReferralsPanel } from "@/components/profile/referrals-panel";

const root = document.getElementById("root");
if (!root) throw new Error("fixture root missing");
createRoot(root).render(<ReferralsPanel />);
