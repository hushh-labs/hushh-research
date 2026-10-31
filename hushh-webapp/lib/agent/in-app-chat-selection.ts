"use client";

// Browser-memory only: a cold app load starts a new Chat, while navigation
// inside the running app can resume the selected conversation.
const selectedByOwner = new Map<string, string | null>();

export function selectedInAppChat(ownerId: string): string | null {
  if (typeof window === "undefined") return null;
  return selectedByOwner.get(ownerId) ?? null;
}

export function rememberInAppChat(ownerId: string, conversationId: string | null): void {
  if (typeof window !== "undefined") selectedByOwner.set(ownerId, conversationId);
}
