# Manish's Drive check (local dashboard)

A local, human-in-the-loop page for checking the deployed Drive request engine,
packets and eval against one owner's real Drive. It is offline tooling: never
deployed, never published, never imported by the runtime (`hushh_eval/` is
excluded from the image).

```
source /Volumes/AnkitSSD/DevCache/p0-20261015/drive-eval-scratch/live-env.sh   # DRIVE_PACKET_EVAL_LIVE=1, owner
python -m hushh_eval.drive_packets dashboard --port 8765        # http://127.0.0.1:8765/
python -m hushh_eval.drive_packets dashboard --check            # startup checks, counts only
```

## What it guarantees

- **One owner.** The owner id comes only from the eval's founder configuration
  (`live-env.sh`, the same line `run-batch` uses). No owner flag, list or lookup;
  a conflicting `DRIVE_PACKET_EVAL_OWNER` or a missing line refuses to start.
- **Deployed engine.** Startup reads UAT's serving `consent-protocol` revision and
  its `deploy-sha` label (describe only), then runs from a checkout of exactly
  that commit (`--engine-root`, or `dashboard-engines/dash-engine-<sha12>` on the
  SSD, added with `git worktree add` when missing), with this checkout's
  `hushh_eval` overlaid. `/api/engine` reports both SHAs; `match` is false (red
  banner) when they differ or the engine checkout has local changes.
- **Read-only UAT.** One connection through the local Cloud SQL proxy with
  `default_transaction_read_only=on`; every session sets and asserts read-only;
  an engine fence refuses any statement that is not one plain read carrying the
  owner id as a bound parameter. Every statement in `queries.STATEMENTS` binds
  the owner on every table (`tests/eval_drive_packets/test_dashboard_sql.py`).
  Drive is GET-only with the owner's stored token; secrets are read with gcloud
  into memory.
- **127.0.0.1 only.** Any other bind address is refused; requests must name this
  machine as Host, and a POST must be JSON from the page's own origin.
- **Private labels.** The founder's labels, dry-run records and caches live in
  `/Volumes/AnkitSSD/DevCache/drive-packets-real-eval-20261014-private/dashboard/`
  (0700, files 0600, append-only JSONL). Packet labels are also written in the
  eval's human-verdict format (`judgments.served.jsonl`).

## API

`GET /api/engine | /api/owner | /api/health | /api/packets | /api/packets/{id} |
/api/requests | /api/requests/{id} | /api/presets | /api/accuracy | /api/eval`,
`POST /api/packets/{id}/label | /api/requests/{id}/label | /api/ask |
/api/ask/{id}/label`. Another owner's packet or request id is a 404. `/api/ask`
and `/api/presets` wrap `dashboard/ask.py` (503 until it is installed). Real
requests show the requester's display name only, and every field the backend did
not store is "not recorded". UAT checkout uses live Stripe keys: a real request
paid for in the app charges real money.
