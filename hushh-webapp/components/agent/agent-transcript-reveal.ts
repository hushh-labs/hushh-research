import { createContext } from "react";

/**
 * Bring an element that just appeared into view above the chat composer. The
 * chat provides it; a card calls it once for the part a person must reach
 * (the ask card's Send, the shared-with-you card), which otherwise could land
 * behind the composer.
 */
export const AgentTranscriptRevealContext = createContext<((element: HTMLElement) => void) | null>(null);
