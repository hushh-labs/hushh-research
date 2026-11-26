import { createRoot } from "react-dom/client";
import { MailFollowupsSessionWatch } from "@/components/gmail/mail-followups-session-watch";
import { MailFollowupsWorkspace } from "@/components/gmail/mail-followups-workspace";

const session = {
  userId: "fixture", vaultKey: "fixture", vaultOwnerToken: "fixture",
};

document.documentElement.dataset.fixturePrivateMail = "true";

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
    <MailFollowupsSessionWatch session={session} />
    <MailFollowupsWorkspace
      session={session}
      onBack={() => {}}
      confirmTransition={async () => false}
    />
  </div>,
);
