# Mirrored Generated Contracts

This directory is a byte-for-byte MIRROR of the repo-root `contracts/`
directory, maintained because Next.js cannot import JSON from outside its
project root. Do not edit anything here; the voice generators write both
copies in one run:

```bash
npm run build:voice-gateway              # gateway + manifest (both copies)
npm run build:route-orchestration-index  # route index (both copies)
```

CI drift check: `npm run verify:voice-gateway` and
`npm run verify:route-orchestration-index`.

See the canonical index at `../../contracts/README.md` for the full
contract-to-generator-to-consumer map.
