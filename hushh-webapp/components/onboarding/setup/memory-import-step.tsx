"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, Copy } from "@/components/icons";
import { toast } from "sonner";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { Button } from "@/lib/morphy-ux/button";
import { useLocalOnboardingActionHandler, type LocalOnboardingActionResult } from "@/lib/agent/local-onboarding-actions";
import { copyToClipboard } from "@/lib/utils/clipboard";
import styles from "./memory-import-step.module.css";

export const MEMORY_EXPORT_PROMPT = "Please share all the information you have about me so I can share it with another AI. Keep it clean, well-organized, and detailed.";
const promptEndIndex = MEMORY_EXPORT_PROMPT.lastIndexOf(" ") + 1;

export function MemoryImportHeader({ busy, onSkip }: { busy: boolean; onSkip: () => void }) {
  return (
    <header className={styles.hero} data-slot="page-header" data-page-primary="true">
      <Button variant="none" effect="fade" size="sm" className={styles.skip} disabled={busy}
        onClick={onSkip} data-voice-control-id="one-memory-import-skip">Skip</Button>
      <div className={styles.brand} aria-hidden="true">
        <Image src="/onboarding/intro-v2/connected-poster.png" alt="" width={144} height={144}
          className={styles.mascot} priority draggable={false} />
        <span className={styles.oneLabel}>One</span>
      </div>
      <h1 className={styles.heroTitle}>Import your memory from other AIs</h1>
      <p className={styles.heroDescription}>Bring what ChatGPT, Claude, or another AI knows about you.</p>
    </header>
  );
}

export function MemoryImportStep({ busy, onFinish, initialText = "" }: {
  busy: boolean;
  initialText?: string;
  onFinish: (text: string) => Promise<LocalOnboardingActionResult>;
}) {
  const [text, setText] = useState(initialText);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = "auto";
    // Match chat: content sets the height; CSS caps it and enables scrolling.
    editor.style.height = `${editor.scrollHeight}px`;
  }, [text]);
  useLocalOnboardingActionHandler("setup.hub_master_ack", () => onFinish(text));
  useLocalOnboardingActionHandler("setup.memory_import_skip", () => onFinish(""));

  const copyPrompt = async () => {
    try {
      if (!await copyToClipboard(MEMORY_EXPORT_PROMPT)) throw new Error("Clipboard unavailable");
      setCopied(true);
    } catch {
      toast.error("Couldn't copy the prompt. Please try again.");
    }
  };

  return (
    <div className={`motion-step-enter ${styles.flow}`} data-testid="onboarding-memory-import">
      <section aria-labelledby="memory-import-prompt-label" className={styles.promptSection}>
        <div className={styles.promptHeading}>
        <h2 id="memory-import-prompt-label" className={styles.stepTitle}>Ask your other AI</h2>
        <Button variant="none" effect="fade" size="sm" className={styles.copy} disabled={busy} onClick={() => void copyPrompt()}
          aria-label={copied ? "Prompt copied" : "Copy prompt"}>
          {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
          {copied ? "Copied" : "Copy prompt"}
        </Button>
        </div>
        <blockquote className={styles.promptQuote}>
          {MEMORY_EXPORT_PROMPT.slice(0, promptEndIndex)}
          <span className={styles.promptEnd}>{MEMORY_EXPORT_PROMPT.slice(promptEndIndex)}</span>
        </blockquote>
      </section>
      <section className={styles.step} aria-labelledby="memory-import-reply-label">
        <label id="memory-import-reply-label" htmlFor="onboarding-imported-memory" className={styles.stepTitle}>Bring the reply to One</label>
        <InputGroup className={styles.composer} aria-labelledby="memory-import-reply-label">
          <InputGroupTextarea ref={editorRef} id="onboarding-imported-memory" value={text} onChange={event => setText(event.target.value)}
            placeholder="Paste a reply, or tell One a little about yourself…" rows={3} disabled={busy}
            autoComplete="off" spellCheck={false} className={styles.editor} />
        </InputGroup>
      </section>
      <div className={styles.footer}>
        <Button variant="blue" effect="fill" size="prominent" fullWidth loading={busy} className={styles.finish}
          onClick={() => void onFinish(text)} data-voice-control-id="one-setup-master-ack" data-voice-action-id="setup.hub_master_ack">
          Finish setup
        </Button>
      </div>
    </div>
  );
}
