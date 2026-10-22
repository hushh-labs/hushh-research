"use client";

import * as React from "react";

import { AlertDialogContent } from "@/components/ui/alert-dialog";
import { DialogContent } from "@/components/ui/dialog";
import { DrawerContent } from "@/components/ui/drawer";
import { SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import styles from "./task-surfaces.module.css";

const TaskSurfaceContext = React.createContext(false);

/** Lets a reusable form adopt task regions without changing its page variant. */
export const useTaskSurfacePresentation = () => React.useContext(TaskSurfaceContext);

type TaskSurfaceSize = "sm" | "md" | "lg";
type TaskRegionProps = React.ComponentProps<"div">;

/**
 * A presentation boundary, mounted by the owning primitive's portal. It does
 * not own open state, dismissal, focus, native isolation, or any feature action.
 */
function TaskSurfaceRegions({ children }: { children: React.ReactNode }) {
  const regionsRef = React.useRef<HTMLDivElement>(null);
  const [frameScroll, setFrameScroll] = React.useState(false);
  const scheduleRef = React.useRef<(() => void) | null>(null);

  React.useLayoutEffect(() => {
    const regions = regionsRef.current;
    const surface = regions?.parentElement;
    if (!regions || !surface) return;

    let frame = 0;
    const observed = new Set<Element>();
    const measure = () => {
      frame = 0;
      const bodies = regions.querySelectorAll<HTMLElement>("[data-task-region='body']");
      const body = Array.from(bodies).find(node => node.getClientRects().length > 0);
      if (!body) return;
      const chrome = surface.querySelectorAll<HTMLElement>(
        "[data-task-region='header'], [data-task-region='toolbar'], [data-task-region='footer'], " +
        "[data-slot='sheet-header'], [data-slot='dialog-header'], [data-slot='drawer-header'], " +
        "[data-slot='alert-dialog-header'], [data-slot='sheet-footer'], [data-slot='dialog-footer'], " +
        "[data-slot='drawer-footer'], [data-slot='alert-dialog-footer'], [data-slot='sheet-drag-handle'], " +
        "[data-slot='drawer-drag-handle']",
      );
      let chromeHeight = 0;
      const ownedChrome = Array.from(chrome).filter(node => {
        const style = window.getComputedStyle(node);
        return node.offsetHeight > 0 && style.position !== "absolute" && style.position !== "fixed" &&
          !Array.from(chrome).some(parent => parent !== node && parent.contains(node));
      });
      for (const node of ownedChrome) {
        const style = window.getComputedStyle(node);
        chromeHeight += node.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        observe(node);
      }
      observe(body);
      const available = surface.clientHeight - chromeHeight;
      const next = available < Math.min(96, body.scrollHeight);
      setFrameScroll(previous => previous === next ? previous : next);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const observe = (node: Element) => {
      if (!observer || observed.has(node)) return;
      observed.add(node);
      observer.observe(node);
    };
    observe(surface);
    scheduleRef.current = schedule;
    schedule();
    window.addEventListener("resize", schedule);
    return () => {
      scheduleRef.current = null;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);

  // Children may appear after an asynchronous feature update without resizing
  // the fixed frame. Remeasure that commit; never observe the app or body tree.
  React.useLayoutEffect(() => { scheduleRef.current?.(); });

  return (
    <TaskSurfaceContext.Provider value={true}><div ref={regionsRef} className={styles.regions} data-task-scroll={frameScroll ? "frame" : "body"}>
      {children}
    </div></TaskSurfaceContext.Provider>
  );
}

type TaskSheetContentProps = React.ComponentProps<typeof SheetContent> & {
  size?: TaskSurfaceSize;
  /** Anchored sheets retain their side; task centering is an explicit opt-in. */
  presentation?: "anchored" | "adaptive";
};

export function TaskSheetContent({
  children, className, size = "md", presentation = "anchored", contentDragDismiss = false,
  ...props
}: TaskSheetContentProps) {
  return (
    <SheetContent
      {...props}
      contentDragDismiss={contentDragDismiss}
      data-task-surface="sheet"
      data-task-size={size}
      data-task-presentation={presentation}
      className={cn(styles.frame, styles.sheet, presentation === "adaptive" && styles.adaptive, className)}
    >
      <TaskSurfaceRegions>{children}</TaskSurfaceRegions>
    </SheetContent>
  );
}

/** CSS changes placement at 768px; forms and their primitive stay mounted. */
export function AdaptiveSheetContent(props: Omit<TaskSheetContentProps, "side" | "presentation">) {
  return <TaskSheetContent {...props} side="bottom" presentation="adaptive" />;
}

export function TaskDialogContent({
  children, className, size = "md", ...props
}: React.ComponentProps<typeof DialogContent> & { size?: TaskSurfaceSize }) {
  return (
    <DialogContent {...props} data-task-surface="dialog" data-task-size={size} className={cn(styles.frame, styles.dialog, className)}>
      <TaskSurfaceRegions>{children}</TaskSurfaceRegions>
    </DialogContent>
  );
}

export function TaskDrawerContent({
  children, className, size = "md", ...props
}: React.ComponentProps<typeof DrawerContent> & { size?: TaskSurfaceSize }) {
  return (
    <DrawerContent {...props} data-task-surface="drawer" data-task-size={size} className={cn(styles.frame, styles.drawer, className)}>
      <TaskSurfaceRegions>{children}</TaskSurfaceRegions>
    </DrawerContent>
  );
}

export function TaskAlertDialogContent({
  children, className, taskSize = "sm", ...props
}: React.ComponentProps<typeof AlertDialogContent> & { taskSize?: TaskSurfaceSize }) {
  return (
    <AlertDialogContent {...props} data-task-surface="confirmation" data-task-size={taskSize} className={cn(styles.frame, styles.dialog, className)}>
      <TaskSurfaceRegions>{children}</TaskSurfaceRegions>
    </AlertDialogContent>
  );
}

export function TaskSurfaceHeader({ className, ...props }: TaskRegionProps) {
  return <div {...props} data-task-region="header" className={cn(styles.header, className)} />;
}

export function TaskSurfaceToolbar({ className, ...props }: TaskRegionProps) {
  return <div {...props} data-task-region="toolbar" className={cn(styles.toolbar, className)} />;
}

export function TaskSurfaceBody({ className, ...props }: TaskRegionProps) {
  return <div {...props} data-task-region="body" className={cn(styles.body, className)} />;
}

export function TaskSurfaceFooter({ className, ...props }: TaskRegionProps) {
  return <div {...props} data-task-region="footer" className={cn(styles.footer, className)} />;
}

export { styles as taskSurfaceStyles };
