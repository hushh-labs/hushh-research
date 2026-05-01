# hushh-ipl-arena

Standalone Hushh IPL Arena app artifact from the downloaded hand-cricket archive.

## Contents

- `archive/hushh-ipl-arena-source.zip`: deployable source archive, kept in sync with `app/`.
- `app/`: extracted Vite/Firebase app source.

## Artifact Integrity

- Original filename: `hushh-🤫-zpl-hand-cricket.zip`
- Original size: `337072` bytes
- Original SHA-256: `2c561af0b9cdae2b6a051bb3cee10ccd8a8ae3c87e505138fb19d8868d325bee`
- Current source archive size: `306432` bytes
- Current source archive SHA-256: `03b1c4d08fd3a8b92695104697fbc2db6bd7b1ba5e3d45ddebce02e9c11e04f2`

## Deployment

Cloud Run service name: `hushh-ipl-arena`

Custom domain target: `ipl-arena.hushh.ai`

The deployable source lives in `app/` and includes a minimal Docker/Nginx wrapper for the static Vite build.
