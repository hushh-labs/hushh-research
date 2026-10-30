import type { ReactNode } from "react";

export type StoryId = "ask" | "know" | "connect" | "control";
export type MascotState = "working" | "thinking" | "answering" | "connected";
export type CompletionReason = "finished" | "skipped";

export interface Story {
  id: StoryId;
  label: string;
  mascot: MascotState;
  title: readonly [string, string];
  description: string;
}

export interface StoryScreenProps {
  headingId: string;
  active: boolean;
  motion: boolean;
  assetBaseUrl: string;
  footer: ReactNode;
  invitationContent?: ReactNode;
  paidDocumentAccess?: boolean;
}
