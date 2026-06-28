"use client";

import { useCallback, useState } from "react";

import { OneLocationService } from "@/lib/one-location/service";

interface ChatLine {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function LocationChatPanel(props: {
  vaultOwnerToken: string;
  onStateChanged?: () => void;
}) {
  const { vaultOwnerToken, onStateChanged } = props;
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;

    setBusy(true);
    setError(null);
    setInput("");
    setLines((prev) => [
      ...prev,
      { id: `u-${prev.length}`, role: "user", text: message },
    ]);

    try {
      const result = await OneLocationService.chat({
        vaultOwnerToken,
        message,
        conversationId,
      });
      setConversationId(result.conversationId);
      setLines((prev) => [
        ...prev,
        { id: `a-${prev.length}`, role: "assistant", text: result.response },
      ]);
      if (result.stateChanged) onStateChanged?.();
    } catch {
      setError("Sorry — that location command could not be processed.");
    } finally {
      setBusy(false);
    }
  }, [input, busy, vaultOwnerToken, conversationId, onStateChanged]);

  return (
    <div data-testid="location-chat-panel">
      <div data-testid="location-chat-log">
        {lines.map((line) => (
          <p key={line.id} data-role={line.role}>
            {line.text}
          </p>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <input
          data-testid="location-chat-input"
          value={input}
          disabled={busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          placeholder="Ask: who can see me? / stop sharing with…"
          aria-label="Ask the location assistant"
        />
        <button
          type="button"
          data-testid="location-chat-send"
          disabled={busy}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
