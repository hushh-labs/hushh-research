---
name: client-env-parity
description: Prevents a client credential from existing in Secret Manager yet never reaching the app that needs it, and prevents an API key from rejecting an origin the app really runs at. Use BEFORE shipping any iOS/TestFlight/App Store or web build, when adding or changing any NEXT_PUBLIC_* value, when adding a build lane, when a feature works on web but not in the app (or the reverse), and whenever a map, embed, analytics tag, or third-party widget renders as a blank box, a placeholder, or a static fallback with no error in the console.
---

Read `skills/client-env-parity/SKILL.md` and follow it.
