"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";

import {
  Check,
  CreditCard,
  FileText,
  MessageCircle,
  Search,
} from "@/components/icons";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import {
  TaskDialogContent,
  TaskSurfaceBody,
  TaskSurfaceFooter,
  TaskSurfaceHeader,
} from "@/lib/morphy-ux/ui/task-surfaces";
import { cn } from "@/lib/utils";

import styles from "./illustrated-request-dialog.module.css";

type RequestIntent = "files" | "drive" | "question" | "card";

const ARTWORK = {
  files: { poster: "working", icon: FileText },
  drive: { poster: "thinking", icon: Search },
  question: { poster: "answering", icon: MessageCircle },
  card: { poster: "answering", icon: CreditCard },
} as const;

/** Decorative composition of the existing, unchanged One onboarding posters. */
function RequestArtwork({
  intent,
  success,
}: {
  intent: RequestIntent;
  success: boolean;
}) {
  const { poster, icon } = ARTWORK[intent];
  const Symbol = success ? Check : icon;
  return (
    <div
      className={styles.artwork}
      data-request-artwork={intent}
      data-success={success || undefined}
      aria-hidden="true"
    >
      <svg className={styles.shapes} viewBox="0 0 184 108" focusable="false">
        <rect
          className={styles.petal}
          x="9"
          y="33"
          width="122"
          height="61"
          rx="30.5"
        />
        <circle className={styles.orbit} cx="126" cy="42" r="34" />
        <path className={styles.dot} d="M159 77h13a12 12 0 0 1 0 24h-13z" />
      </svg>
      {/* These originals are shared with onboarding; no preview asset copy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/onboarding/intro-v2/${poster}-poster.png`}
        alt=""
        width={128}
        height={128}
        decoding="async"
        draggable={false}
      />
      <span className={styles.symbol}>
        <Symbol />
      </span>
    </div>
  );
}

type IllustratedRequestContentProps = ComponentProps<
  typeof TaskDialogContent
> & {
  intent: RequestIntent;
  title: string;
  description: ReactNode;
  /** Presentation follows the owning controller's acknowledged result. */
  success?: boolean;
};

/**
 * One request presentation over the existing Dialog owner. Feature controllers
 * retain open state, busy dismissal, validation, native isolation and actions.
 */
export function IllustratedRequestContent({
  intent,
  title,
  description,
  success = false,
  children,
  className,
  onOpenAutoFocus,
  ...props
}: IllustratedRequestContentProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const descriptionId = useId();
  useLayoutEffect(() => {
    if (success) titleRef.current?.focus({ preventScroll: true });
  }, [success]);

  return (
    <TaskDialogContent
      {...props}
      aria-describedby={props["aria-describedby"] ?? descriptionId}
      data-request-dialog={intent}
      data-request-success={success || undefined}
      className={cn(
        styles.frame,
        "max-md:translate-x-0 max-md:translate-y-0",
        className,
      )}
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        if (success && !event.defaultPrevented && titleRef.current) {
          event.preventDefault();
          titleRef.current.focus({ preventScroll: true });
        }
      }}
    >
      <TaskSurfaceHeader className={styles.header}>
        <RequestArtwork intent={intent} success={success} />
        <DialogTitle ref={titleRef} tabIndex={success ? -1 : undefined} className={TYPOGRAPHY_CLASSNAMES.sectionTitle}>
          {title}
        </DialogTitle>
        <DialogDescription id={descriptionId}>{description}</DialogDescription>
      </TaskSurfaceHeader>
      {children}
    </TaskDialogContent>
  );
}

export function IllustratedRequestForm({
  className,
  ...props
}: ComponentProps<"form">) {
  return <form {...props} className={cn(styles.form, className)} />;
}

export function IllustratedRequestBody({
  className,
  ...props
}: ComponentProps<typeof TaskSurfaceBody>) {
  return <TaskSurfaceBody {...props} className={cn(styles.body, className)} />;
}

export function IllustratedRequestActions({
  className,
  ...props
}: ComponentProps<typeof TaskSurfaceFooter>) {
  return (
    <TaskSurfaceFooter {...props} className={cn(styles.actions, className)} />
  );
}
