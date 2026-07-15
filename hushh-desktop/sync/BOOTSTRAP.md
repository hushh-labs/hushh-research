# Desktop Alpha Bootstrap Manifest

This document records the exact baseline commits from which the `hushh-desktop` application was scaffolded. This provides immediate context for reviewers and future developers to track changes and synchronize features.

## Source Baselines

- **Frontend Source**: `hushh-webapp` @ commit `d1b402b89a7733169c4258c0392bb97ec5ca836b` (upstream integration baseline)
- **Backend Source**: `consent-protocol` @ commit `d1b402b89a7733169c4258c0392bb97ec5ca836b` (upstream integration baseline)
- **Imported On**: 2026-06-30

## Purpose
Establish a standalone Desktop Alpha baseline by packaging the web-based microservices and web application into a cohesive offline desktop executable.

## Desktop-Specific Surface Area
Unlike the core web/backend, the following files and directories are completely unique to the desktop client:
- **`electron/`**: Electron main, renderer, and IPC bridge scripts.
- **`installer/`**: Packaged executable output target directory (currently portable ZIP).
- **`main/` & `launcher.js`**: Desktop application bootstrapper, process managers (for frontend standalone servers + FastAPI background server), and `.env` parser.
- **`electron/preload/preload.js`**: The context bridge mapping native Capacitor plugins to Electron IPC handlers.

## Future Synchronization Strategy
- Future updates will utilize **manual, feature-level imports** and schema updates as components evolve, ensuring we don't accidentally overwrite desktop-specific IPC hooks or configuration files.
- Track synchronization events in this `sync/` directory.
