"use client";

import { useState } from "react";

interface InviteLinkButtonProps {
  code: string;
  onGetCode: () => Promise<string>;
}

export function InviteLinkButton({ code, onGetCode }: InviteLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const finalCode = code || (await onGetCode());
      const url = `${window.location.origin}/ialphabets/join/${finalCode}`;

      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({
          title: "Join my iAlphabets league!",
          text: "Draft 26 stocks and compete with me!",
          url,
        });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // user cancelled share
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="rounded-lg border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
    >
      {loading ? "..." : copied ? "Copied!" : "Invite Friends"}
    </button>
  );
}
