import { createRoot } from "react-dom/client";
import { MailFollowupsWorkspace } from "@/components/gmail/mail-followups-workspace";

createRoot(document.getElementById("root")!).render(
  <MailFollowupsWorkspace
    session={{
      userId: "fixture",
      vaultKey: "fixture",
      vaultOwnerToken: "fixture",
    }}
    onBack={() => {}}
    confirmTransition={async () => false}
  />,
);
