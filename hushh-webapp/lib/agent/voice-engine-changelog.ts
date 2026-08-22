/**
 * Voice-engine "what's new" content, checked in and reviewed like any other
 * code change -- there is no admin UI. Whoever ships a voice-engine
 * improvement adds one entry here (newest first) and bumps
 * VOICE_ENGINE_VERSION in the same PR, so the version shown in the settings
 * header always matches the changelog under it.
 */
export const VOICE_ENGINE_VERSION = "1.0";

export type VoiceEngineChangelogEntry = {
  version: string;
  /** ISO date, e.g. "2026-08-16". */
  date: string;
  title: string;
  description: string;
};

export const VOICE_ENGINE_CHANGELOG: readonly VoiceEngineChangelogEntry[] = [
  {
    version: "1.0",
    date: "2026-08-22",
    title: "Walk-through mode",
    description:
      "Turn on Walk-through mode in Voice Settings to see a live list of steps as One works through a request with more than one part, alongside what it says.",
  },
  {
    version: "1.0",
    date: "2026-08-22",
    title: "Fixed: sending a connection request by voice required typing",
    description:
      "Connect could stop at a search box after hearing a name instead of sending the request itself. It now resolves the name and sends hands-free, the same way it always could.",
  },
  {
    version: "1.0",
    date: "2026-08-22",
    title: "Location voice commands pick the right one more often",
    description:
      "A few Location commands sounded alike -- \"stop sharing\" versus \"stop sharing my location\", or the SOS screen versus a real alert -- and could be picked wrong. One now tells them apart correctly.",
  },
  {
    version: "1.0",
    date: "2026-08-22",
    title: "Ambiguous names show a list to pick from",
    description:
      "When a spoken name matched more than one person in Location or Circles, One used to just say so and ask again. It now shows the matches so you can tap the right one.",
  },
  {
    version: "1.0",
    date: "2026-08-16",
    title: "Voice settings",
    description:
      "Turn voice on or off, require a tap to confirm risky actions, and choose which domains voice can act in -- all from one place.",
  },
  {
    version: "1.0",
    date: "2026-08-16",
    title: "Fixed: a completed share sometimes narrated as failed",
    description:
      "Sharing your location by voice could say \"no one is selected\" for a share that had already gone through, because the narration read app state a beat before it had updated. Fixed at the source.",
  },
  {
    version: "1.0",
    date: "2026-08-16",
    title: "Fixed: some Location voice commands stopped responding",
    description:
      "Location grew past the number of commands voice could track on one screen at a time, so newer commands like adding or removing someone from a circle silently stopped working. Voice now carries enough room for all of them.",
  },
  {
    version: "1.0",
    date: "2026-08-16",
    title: "Fixed: voice lost track of a few newer screens",
    description:
      "Calendar setup, the Calendar page, and nearby check-in were sometimes treated as a generic screen, which could make their own voice commands unavailable. Voice now recognizes all three correctly.",
  },
  {
    version: "1.0",
    date: "2026-08-16",
    title: "The agent knows its own limits",
    description:
      "Voice now says so plainly when something needs doing one person at a time, or when getting someone more time on a share means asking again rather than an instant extension -- instead of implying it can do either in one step.",
  },
] as const;
