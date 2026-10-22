import { createRoot } from "react-dom/client";
import { useState } from "react";

import { AgentMarkdown } from "../../components/agent/agent-markdown";
import { AgentTurnStreamPanel } from "../../components/agent/agent-turn-stream-panel";
import { AppStreamSection } from "../../components/app-ui/stream-progress-panel";
import { PuppyOneSurface } from "../../components/agent/puppy-one-surface";
import { PUPPY_TYPOGRAPHY_ANSWER } from "./agent-markdown-boundaries";
import { SoulMemoryDocument } from "../../components/profile/soul-memory-document";
import {
  CHAT_USER_BUBBLE_CLASSNAME,
  CHAT_WELCOME_COPY_CLASSNAME,
  OneChatBubble,
  ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME,
} from "../../components/agent/chat-message-styles";

/**
 * Realistic One answers, rendered by the real `AgentMarkdown` inside the real
 * chat bubble classes and the `[data-one-chat-surface]` token scope, so a spec
 * measures the reading experience a person gets without a signed-in session.
 *
 * Every kind of content an answer carries is here once: bare and labelled
 * links (several to one domain), a long query-string URL, email and phone,
 * headings, nested and task lists, code with a language and a long line,
 * a wide table, a quote, a rule, footnote citations, money and dates, emoji,
 * mixed-direction text, one very long unbroken token, and a turn caught
 * mid-stream with an open fence and a half-written table row.
 */
const FENCE = "```";

export const AGENT_MARKDOWN_FIXTURE_MESSAGES: Array<{
  id: string;
  role: "user" | "assistant";
  text: string;
}> = [
  {
    id: "ask-flights",
    role: "user",
    text: "Find me flights to Lisbon mid October, nonstop if the price is close.",
  },
  {
    id: "flights",
    role: "assistant",
    text: [
      "## Flights to Lisbon",
      "",
      "I checked fares for **SFO to LIS**, leaving *Oct 14* and returning *Oct 21*. The cheapest nonstop is TAP at **$842.60** round trip[^1], and United's one-stop through Newark is $796.10[^2].",
      "",
      "| Airline | Route | Stops | Price | Duration | Baggage |",
      "|---|---|---:|---:|---|---|",
      "| TAP Air Portugal | SFO to LIS | 0 | $842.60 | 11h 05m | 1 checked bag |",
      "| United | SFO to EWR to LIS | 1 | $796.10 | 14h 40m | Carry-on only |",
      "| Lufthansa | SFO to FRA to LIS | 1 | $1,012.00 | 16h 15m | 1 checked bag |",
      "| Air France | SFO to CDG to LIS | 1 | $934.25 | 15h 50m | 1 checked bag |",
      "",
      "> Fares move quickly. If one of these works, book within a day.",
      "",
      "Compare them yourself: https://www.google.com/travel/flights/search?tfs=CBwQAhooEgoyMDI2LTEwLTE0agcIARIDU0ZPcgcIARIDTElTQAFIAXABggELCP___________wGYAQE&hl=en-US&gl=US&curr=USD",
      "",
      "[^1]: [TAP Air Portugal fares](https://www.flytap.com/en-us/flights/sfo-lis)",
      "[^2]: [United, SFO to Lisbon](https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=LIS&d=2026-10-14)",
    ].join("\n"),
  },
  {
    id: "contact",
    role: "assistant",
    text: [
      "Here is what I found for **Dr. Maya Patel**:",
      "",
      "- **Email:** maya.patel@stanfordhealthcare.org",
      "- **Phone:** +1 (650) 555-0142",
      "- **Office:** 300 Pasteur Dr, Stanford, CA",
      "- **Next opening:** Tue, Oct 7 at 9:30 AM",
      "",
      "### Before your visit",
      "",
      "1. Bring your insurance card",
      "2. Fill in the intake form",
      "   - Medical history",
      "   - Current medications",
      "     - Include dosages",
      "3. Arrive 15 minutes early",
      "",
      "#### Checklist",
      "",
      "- [x] Insurance verified",
      "- [ ] Intake form submitted",
      "- [ ] Parking reserved",
      "",
      "More on [her profile](https://stanfordhealthcare.org/doctors/p/maya-patel.html), [the clinic page](https://stanfordhealthcare.org/medical-clinics/primary-care.html) and [the parking guide](https://stanfordhealthcare.org/for-patients-visitors/parking.html).",
    ].join("\n"),
  },
  {
    id: "code",
    role: "assistant",
    text: [
      "# September export",
      "",
      "Run this to export the report:",
      "",
      `${FENCE}bash`,
      'curl -sS -H "Authorization: Bearer $HUSSH_TOKEN" "https://api.example.com/v1/reports/export?format=csv&from=2026-09-01&to=2026-09-30&include=holdings,transactions,dividends" -o september.csv',
      FENCE,
      "",
      'Then load it with `pandas.read_csv("september.csv")`:',
      "",
      `${FENCE}python`,
      "import pandas as pd",
      'df = pd.read_csv("september.csv")',
      'print(df.groupby("account")["amount"].sum())',
      FENCE,
      "",
      "---",
      "",
      "Your balance is **$12,480.55** as of **Sep 29, 2026**. 🎉",
    ].join("\n"),
  },
  {
    id: "edges",
    role: "assistant",
    text: [
      "**Checking ••4821**",
      "",
      "- Available: $3,204.18",
      "- Pending: -$84.00",
      "- Updated: 2026-09-29 08:15",
      "",
      "مرحبا بك في Hussh One, and the English carries on in the same line (עברית גם עובדת).",
      "",
      "Reference: 7f3a9c0e1b2d4f5a6c7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9",
      "",
      "See www.example.com/guides/lisbon, or https://example.com/a?b=1&c=2. (Background: https://en.wikipedia.org/wiki/Lisbon_(disambiguation)).",
      "",
      "Ignore [this](javascript:alert(1)) and ![tracker](https://tracker.example.com/pixel.gif?id=42).",
    ].join("\n"),
  },
  {
    id: "streaming",
    role: "assistant",
    text: [
      "Comparing the two plans:",
      "",
      "| Plan | Monthly | Annual |",
      "|---|---:|---:|",
      "| Basic | $9 | $90 |",
      "| Pro | $19",
      "",
      `${FENCE}ts`,
      "const total = plans.reduce((sum, plan) =>",
    ].join("\n"),
  },
];

function Transcript() {
  return (
    <div
      data-one-chat-surface
      className="min-h-dvh bg-[color:var(--one-chat-canvas)] text-foreground"
    >
      <div
        data-testid="transcript"
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6"
      >
        {AGENT_MARKDOWN_FIXTURE_MESSAGES.map((message) => {
          const isUser = message.role === "user";
          return (
            <div
              key={message.id}
              data-message-role={message.role}
              data-testid={`message-${message.id}`}
              className={`flex w-full items-start gap-2 ${isUser ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`min-w-0 max-w-[90%] sm:max-w-[min(82%,48rem)] ${isUser ? "sm:max-w-[min(76%,42rem)]" : ""}`}
              >
                <div
                  className={`text-sm leading-6 ${isUser ? CHAT_USER_BUBBLE_CLASSNAME : `${ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME} relative`}`}
                >
                  {isUser ? (
                    <span className="whitespace-pre-wrap break-words">{message.text}</span>
                  ) : (
                    <AgentMarkdown text={message.text} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SoulDocument() {
  return <main className="app-page-shell px-4 py-6" data-testid="transcript">
    <SoulMemoryDocument markdown={[
      "# Soul.md", "", "## Facts", "",
      "- **Alex** studies a synthetic engineering course at Example University.",
      "- Works with Example Team on an owner-controlled research project.",
      `- Project reference: https://example.test/${"a".repeat(160)}`,
      "", "## Preferences", "",
      "- Prefers concise replies with clear next steps and links to supporting evidence.",
      "- Likes readable Markdown documents instead of nested record trees.",
      "", "## Commitments", "",
      "- Plans to finish the synthetic project by the end of the month.",
    ].join("\n")} />
  </main>;
}

function ActivityTranscript() {
  const [streaming, setStreaming] = useState(false);
  return (
    <main data-one-chat-surface className="min-h-dvh bg-[color:var(--one-chat-canvas)] p-4 text-foreground" data-testid="transcript">
      <div className="mx-auto max-w-3xl space-y-4">
        <AgentTurnStreamPanel
          streamEvents={[{ id: "calendar-step", label: "Calendar", message: streaming ? "Reading calendar events." : "Calendar checked.", status: streaming ? "running" : "done", createdAtMs: Date.now() - 1000 }]}
          responseText="Your calendar is ready."
          isStreaming={streaming}
        />
        <button type="button" onClick={() => setStreaming(true)}>Start stream</button>
        <button type="button" onClick={() => setStreaming(false)}>Finish stream</button>
        <AppStreamSection title="Import progress" items={[]} defaultOpen={false} />
      </div>
    </main>
  );
}

const documentKind = new URLSearchParams(window.location.search).get("document");

function PuppyTypography() {
  const [connected, setConnected] = useState(false);
  return (
    <main className="bg-background text-foreground" data-testid="transcript">
      <section data-one-chat-surface data-testid="opening-chat" className="px-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <p className={CHAT_WELCOME_COPY_CLASSNAME}>What would you like to do today?</p>
          <OneChatBubble tone="user" data-testid="opening-user">Compare the chat spacing.</OneChatBubble>
          <OneChatBubble tone="assistant" data-testid="opening-assistant"><AgentMarkdown text={PUPPY_TYPOGRAPHY_ANSWER} /></OneChatBubble>
          <textarea aria-label="Opening chat composer" className="agent-chat-composer-field text-[16px]" />
        </div>
      </section>
      <section className="flex h-[650px] flex-col" data-testid="puppy-chat">
        <PuppyOneSurface key={String(connected)} />
      </section>
      <button type="button" onClick={() => {
        document.body.dataset.puppyConnected = "true";
        setConnected(true);
      }}>Connect synthetic Puppy</button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  documentKind === "soul" ? <SoulDocument /> : documentKind === "activity" ? <ActivityTranscript /> : documentKind === "puppy" ? <PuppyTypography /> : <Transcript />,
);
