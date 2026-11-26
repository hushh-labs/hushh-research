import { createRoot } from "react-dom/client";
import { MailFollowupsWorkspace } from "@/components/gmail/mail-followups-workspace";

createRoot(document.getElementById("root")!).render(
  <div
    style={{
      maxWidth: 1056,
      margin: "auto",
      padding: "16px 20px 80px",
      height: "100dvh",
      overflowY: "auto",
    }}
  >
    <MailFollowupsWorkspace
      session={{
        userId: "fixture",
        vaultKey: "fixture",
        vaultOwnerToken: "fixture",
      }}
      onBack={() => {}}
      confirmTransition={async () => false}
    />
  </div>,
);
