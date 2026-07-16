#!/usr/bin/env node

// Compatibility entrypoint. The PKM upgrade rehearsal skill owns the implementation.
await import("../../pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs");
