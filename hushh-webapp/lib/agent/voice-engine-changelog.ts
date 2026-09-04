/**
 * Voice-engine "what's new" content, checked in and reviewed like any other
 * code change -- there is no admin UI. Whoever ships a voice-engine
 * improvement adds one entry here (newest first) and bumps
 * VOICE_ENGINE_VERSION in the same PR, so the version shown in the settings
 * header always matches the changelog under it.
 */
export const VOICE_ENGINE_VERSION = "1.6";

export type VoiceEngineChangelogEntry = {
  version: string;
  /** ISO date, e.g. "2026-08-16". */
  date: string;
  title: string;
  description: string;
};

export const VOICE_ENGINE_CHANGELOG: readonly VoiceEngineChangelogEntry[] = [
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Fixed: voice said an action opened somewhere it didn't",
    description:
      "Opening a screen by voice could report it as having opened in a completely different part of the app -- \"Voice Settings opened in Finance.\" The action was right; only the sentence was wrong. It now names what it opened and nothing else.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Answer a connection request from your Feed, hands-free",
    description:
      "Saying \"accept their request\" while looking at your Feed now works directly. Voice offered nothing at all on that screen before, even though it could already do this.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Find people from your contacts, by voice",
    description:
      "Ask One to check your contacts against Hussh from the Location screen. It could always do this; it was just never offered.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Fixed: action cards cut off the message and repeated themselves",
    description:
      "A long line -- like being told to add an emergency contact before sending an SOS -- was trimmed with dots part way through, hiding the part that told you what to do. Asking twice for the same thing also stacked the same line up twice. Cards now show the whole message, once.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Fixed: a few phrases could match two different commands",
    description:
      "Some wording belonged to two commands at once, so which one ran was a coin flip. Every phrase now points at a single command, and the one on the screen you are looking at wins when two screens share a name.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Voice now works on Your Map and Check in",
    description:
      "Those two screens offered no voice commands at all -- checking in near you, confirming a place, or checking out only worked from the Location hub. They now work while you are actually looking at them.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Fixed: many Location commands were never offered",
    description:
      "Approving a request, creating a circle, sending an SOS, saving a place and more existed but were never suggested, so they usually did nothing unless you named them exactly. Everything Location can do is now offered.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Fixed: a few \"open X\" requests before sign-in said they weren't available",
    description:
      "On the very first screen, before your vault is unlocked, asking to open certain Hussh screens could say they weren't available even though they were. Voice now only offers what it can actually open there.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Fixed: \"stop sharing\" now actually stops sharing",
    description:
      "Saying \"stop sharing\" with no name attached used to just open the list of who could see you -- nothing stopped. It now pauses your location right away, the same as tapping pause yourself.",
  },
  {
    version: "1.6",
    date: "2026-08-28",
    title: "Fixed: a few Location and Connect commands could pick the wrong one",
    description:
      "Some phrasing -- \"send it\" while sharing or asking, a nameless \"connect with someone\", a bare \"accept\" or \"decline\" near a circle invite -- could land on the wrong action or do nothing. Each of these now points at exactly one thing.",
  },
  {
    version: "1.6",
    date: "2026-08-27",
    title: "Voice commands are more consistent on close or urgent phrasing",
    description:
      "The same request said two different ways -- like \"save me\" versus \"trigger sos\" -- could go to different places, or nowhere. Voice now checks a wider set of matches before guessing, so close wording lands on the same result reliably.",
  },
  {
    version: "1.6",
    date: "2026-08-27",
    title: "Fixed: some \"open X\" voice commands went quiet on busy screens",
    description:
      "Saying things like \"open voice settings\" or \"open my feed\" could stop working once a screen had enough of its own commands, like Location. Navigation commands now work from every screen, all the time.",
  },
  {
    version: "1.6",
    date: "2026-08-26",
    title: "Set what \"help\" does in an emergency",
    description:
      "Choose in Voice Settings whether a bare emergency phrase like \"save me\" or \"SOS\" opens the SOS screen or goes straight to sending the alert. Either way, sending still needs an explicit confirmation -- this only changes how fast you get there.",
  },
  {
    version: "1.6",
    date: "2026-08-26",
    title: "Accept or decline a connection request, hands-free",
    description:
      "Say \"accept their connection request\" or \"decline request\" for a request waiting in your Feed -- no need to open it and tap. Asking to connect with someone who already asked you now points you straight to this instead of trying to send a second request.",
  },
  {
    version: "1.6",
    date: "2026-08-26",
    title: "Fixed: Nearby Check-In said no places were found when the real problem was something else",
    description:
      "If location access was off or the search itself failed, Nearby Check-In said \"no plausible places nearby\" either way. It now says what actually went wrong, so it's clear whether to check permissions or just search for the place yourself.",
  },
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
    version: "1.5",
    date: "2026-08-26",
    title: "A repeat connection request can reuse what you offered last time",
    description:
      "Turn on \"Reuse scopes from last request\" in Voice Settings, and asking to connect with someone you've already asked before offers the same access as last time -- they still approve every request either way.",
  },
  {
    version: "1.5",
    date: "2026-08-26",
    title: "Check in nearby, hands-free",
    description:
      "Say \"check in near me\" to see the places closest to you, pick one by name, and finish the check-in -- all without opening the screen. \"Check out\" ends it from anywhere, no navigation needed.",
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
