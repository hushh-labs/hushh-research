import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MailConnectedAccount, MailOverview } from "../../components/gmail/mail-overview";

function Fixture() {
  const [fetching, setFetching] = useState(true);
  const [action, setAction] = useState("");
  return <main className="app-page-shell mx-auto w-full max-w-[680px] bg-background px-6 py-8 text-foreground">
    <MailConnectedAccount onReconnect={() => setAction("reconnect")} onDisconnect={() => setAction("disconnect")} />
    <output data-testid="mail-action" className="sr-only">{action}</output>
    <MailOverview fetching={fetching} receiptDetail={fetching ? "Fetching your latest purchases…" : "Your latest receipts are ready."} receiptUpdated="Last updated just now." onOpenChat={() => {}} />
    <button onClick={() => setFetching(false)}>Finish sync</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
