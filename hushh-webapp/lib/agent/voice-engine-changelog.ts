/**
 * Voice-engine "what's new" content, checked in and reviewed like any other
 * code change -- there is no admin UI. Whoever ships a voice-engine
 * improvement adds one entry here (newest first) and bumps
 * VOICE_ENGINE_VERSION in the same PR, so the version shown in the settings
 * header always matches the changelog under it.
 */
export const VOICE_ENGINE_VERSION = "1.5";

export type VoiceEngineChangelogEntry = {
  version: string;
  /** ISO date, e.g. "2026-08-16". */
  date: string;
  title: string;
  description: string;
};

export const VOICE_ENGINE_CHANGELOG: readonly VoiceEngineChangelogEntry[] = [
  {
    version: "1.5",
    date: "2026-08-26",
    title: "Your own defaults for what voice can do",
    description:
      "Auto-approving location requests, who can see you in Nearby Check-In, and whether a repeat connection request reuses your last choice are now settings you set once, in Voice Settings, instead of decisions made for you every time.",
  },
  {
    version: "1.5",
    date: "2026-08-26",
    title: "\"Open Voice Settings\" now works from anywhere",
    description:
      "Voice Settings is reachable hands-free from any screen -- say \"open voice settings\" to reach it and adjust anything above without touching the screen.",
  },
  {
    version: "1.4",
    date: "2026-08-25",
    title: "These actions now run the moment you ask",
    description:
      "Sharing your location, sending a connection request, stopping a share, and approving or declining a request used to need you on the right screen first. They now run directly and show what happened, from anywhere in the app.",
  },
  {
    version: "1.4",
    date: "2026-08-25",
    title: "Say it once, for everyone",
    description:
      "Sharing your location, asking someone for theirs, and sending a connection request now understand more than one name in the same sentence -- \"share my location with Alex and Sam for 2 hours\" works in one turn, the same way adding people to a Circle already did.",
  },
  {
    version: "1.3",
    date: "2026-08-23",
    title: "A dropped connection reconnects on its own",
    description:
      "If the voice session drops in a way it can recover from, One now reconnects once by itself, right where the conversation left off, instead of leaving you talking to a dead microphone.",
  },
  {
    version: "1.3",
    date: "2026-08-23",
    title: "Voice now says what went wrong, with a way back",
    description:
      "When a voice session breaks, you'll see the actual reason and a Try Again button in one tap -- instead of a status line that quietly stops updating.",
  },
  {
    version: "1.3",
    date: "2026-08-23",
    title: "Fixed: voice could cut you off or wait too long to respond",
    description:
      "A turn-taking bug could make voice interrupt you mid-sentence or leave a longer-than-usual pause before responding. Fixed at the source.",
  },
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
