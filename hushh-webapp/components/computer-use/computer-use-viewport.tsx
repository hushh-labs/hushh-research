"use client";

import type { RefObject } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fitComputerUseViewport } from "@/lib/computer-use/preview-canvas";
import type { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import { morphyToast } from "@/lib/morphy-ux/morphy";

const SIZES = {
  phone: { width: 390, height: 700 },
  tablet: { width: 820, height: 1000 },
  desktop: { width: 1280, height: 720 },
} as const;

/** Reflow is an explicit owner action; preview resizing never resumes the agent. */
export function ComputerUseViewport({ controller, surface, disabled }: {
  controller: ComputerUseTaskController;
  surface: RefObject<HTMLDivElement | null>;
  disabled: boolean;
}) {
  function resize(size: { width: number; height: number }): void {
    const current = controller.getSnapshot().snapshot?.viewport;
    if (disabled || !current || (current.width === size.width && current.height === size.height)) return;
    const operation = controller.input({ operation: "resize", ...size });
    morphyToast.promise(operation, {
      loading: "Resizing browser…", success: "Browser resized.",
      error: "Couldn’t confirm the browser size. Reconnect before continuing.",
    });
    void operation.catch(() => undefined);
  }

  function fit(): void {
    const target = surface.current;
    const bounds = target?.getBoundingClientRect();
    if (!target?.clientWidth || !bounds) return;
    const height = Math.min(window.innerHeight * 0.65, window.innerHeight - bounds.top - 120);
    resize(fitComputerUseViewport(target.clientWidth, height));
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ShellActionSurface variant="pill" className="min-h-11" disabled={disabled} onClick={fit}>
        Fit this screen
      </ShellActionSurface>
      <Select value="" disabled={disabled} onValueChange={(value) => {
        if (Object.hasOwn(SIZES, value)) resize(SIZES[value as keyof typeof SIZES]);
      }}>
        <SelectTrigger aria-label="Browser size" className="min-h-11 w-auto min-w-36">
          <SelectValue placeholder="Screen size" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="phone">Phone</SelectItem>
          <SelectItem value="tablet">Tablet</SelectItem>
          <SelectItem value="desktop">Desktop</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
