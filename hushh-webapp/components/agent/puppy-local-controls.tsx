"use client";

import type { ReactNode } from "react";
import { Laptop, Loader2 } from "@/components/icons";
import { PuppyControlRibbon } from "@/components/agent/puppy-chat-controls";
import { PuppyModelPicker, type ModelSelection } from "@/components/agent/puppy-model-picker";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { cn } from "@/lib/utils";

export function PuppyLocalControls({ active, connected, currentModel, pill, onDevice, onTogglePin, onApplied, accessory }: {
  active: boolean;
  connected: boolean;
  currentModel?: string;
  pill: { live: boolean; label: string; pending: boolean };
  onDevice: boolean;
  onTogglePin: () => void;
  onApplied: (selection: ModelSelection) => void;
  accessory?: ReactNode;
}) {
  return (
      <PuppyControlRibbon accessory={accessory}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        {!connected ? <><Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-2 py-0.5",
            pill.live
              ? "bg-[color:var(--app-success-tint)] text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]"
              : "bg-muted text-muted-foreground",
          )}
        >
          {pill.pending ? (
            <Loader2 className="size-2.5 animate-spin" aria-hidden />
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full",
                pill.live ? "bg-current" : "bg-muted-foreground/60",
              )}
            />
          )}
          <span className="min-w-0 truncate">{pill.label}</span>
        </span>
        </> : null}
        {connected ? (
          <PuppyModelPicker currentModel={currentModel} active={active} onApplied={onApplied} className="min-w-0" />
        ) : null}
        {connected ? (
          <ShellActionSurface
            variant="pill"
            type="button"
            disabled={!active}
            onClick={onTogglePin}
            aria-pressed={onDevice}
            className={cn(
              "h-11 px-3 text-xs font-medium sm:px-3 sm:text-sm",
              onDevice
                ? "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={
              onDevice
                ? "Answers are generated on this machine."
                : "Answers may use a cloud model."
            }
          >
            {onDevice ? "on-device" : "any model"}
          </ShellActionSurface>
        ) : null}
      </div>
      </PuppyControlRibbon>
  );
}
