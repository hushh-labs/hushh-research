import { useState } from "react";
import { Toaster } from "sonner";
import { createRoot } from "react-dom/client";
import { MailFollowupsSessionWatch } from "@/components/gmail/mail-followups-session-watch";
import { MailFollowupsWorkspace } from "@/components/gmail/mail-followups-workspace";

const session = {
  userId: "fixture", vaultKey: "fixture", vaultOwnerToken: "fixture",
};

document.documentElement.dataset.fixturePrivateMail = "true";

function Fixture() {
  const [mailOpen, setMailOpen] = useState(true);
  return (
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
      {document.documentElement.dataset.journey === "reminders" && (
        <>
          <Toaster />
          <button onClick={() => setMailOpen(!mailOpen)}>{mailOpen ? "Leave Mail" : "Return to Mail"}</button>
        </>
      )}
      {mailOpen && <MailFollowupsWorkspace
        session={session}
        onBack={() => {}}
        confirmTransition={async () => false}
      />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
