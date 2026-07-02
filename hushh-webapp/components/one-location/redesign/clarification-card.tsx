"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { ClientPrompt, PromptOption } from "@/lib/one-location/types";

function sameRef(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ClarificationCard({
  prompt,
  busy,
  onAnswer,
  onConfirm,
  onCancel,
}: {
  prompt: ClientPrompt;
  busy: boolean;
  onAnswer: (refs: Record<string, unknown>[]) => void;
  onConfirm: (yes: boolean) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, unknown>[]>([]);
  const single = prompt.kind === "select" && prompt.maxSelections === 1;

  const toggle = (opt: PromptOption) => {
    if (single) {
      onAnswer([opt.ref]); // single-pick auto-answers on tap
      return;
    }
    setPicked((prev) =>
      prev.some((r) => sameRef(r, opt.ref))
        ? prev.filter((r) => !sameRef(r, opt.ref))
        : [...prev, opt.ref],
    );
  };

  return (
    <div
      data-testid="clarification-card"
      className="rounded-2xl border border-[#b8894d]/40 bg-[#b8894d]/5 p-4"
    >
      <p className="text-sm font-medium">{prompt.question}</p>

      {prompt.kind === "select" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {(prompt.options ?? []).map((opt) => {
            const active = picked.some((r) => sameRef(r, opt.ref));
            return (
              <button
                key={opt.label}
                type="button"
                data-testid="clarification-option"
                disabled={busy}
                onClick={() => toggle(opt)}
                className={
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors " +
                  (active
                    ? "border-[#b8894d] bg-[#b8894d]/15 text-[#b8894d]"
                    : "border-[color:var(--app-card-border-standard)] text-foreground hover:border-[#d4a574]/50")
                }
              >
                {opt.label}
                {opt.hint ? <span className="ml-1 opacity-60">· {opt.hint}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        {prompt.kind === "confirm" ? (
          <Button
            data-testid="clarification-confirm"
            size="sm"
            isLoading={busy}
            variant={prompt.destructive ? "destructive" : "default"}
            onClick={() => onConfirm(true)}
          >
            {prompt.confirmLabel ?? "Yes"}
          </Button>
        ) : (
          <Button
            data-testid="clarification-confirm"
            size="sm"
            isLoading={busy}
            disabled={busy || (!single && picked.length < (prompt.minSelections ?? 1))}
            onClick={() => onAnswer(picked)}
          >
            {prompt.confirmLabel ?? "Confirm"}
          </Button>
        )}
        <Button
          data-testid="clarification-cancel"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {prompt.cancelLabel ?? "Cancel"}
        </Button>
      </div>
    </div>
  );
}
