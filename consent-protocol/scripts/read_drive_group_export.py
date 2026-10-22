#!/usr/bin/env python3
"""Validate/recover a local encrypted Drive export without downloading or embedding.

The backend's existing Drive processing key decrypts the checkpoint. A private
plaintext CSV is written only with --output and --include-content. Stdout carries
counts only. This does not invoke a provider or write a server index or PKM.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--include-content", action="store_true")
    parser.add_argument(
        "--key-project", help="Read the fixed processing key from this project, or 'backend'."
    )
    args = parser.parse_args()
    from dotenv import load_dotenv

    try:
        if not args.env_file.is_file():
            raise RuntimeError("configuration_unavailable")
        load_dotenv(args.env_file, override=False)
        # Runtime imports may load repository defaults; the explicitly selected
        # configuration must be present before that bootstrap can run.
        from hushh_mcp.services.drive_groups.export import csv_text, pending_rows
        from scripts.drive_group_local_content import checkpoint_columns, open_checkpoint
        from scripts.export_drive_groups import _load_secrets, _write

        if args.key_project and not os.getenv("DRIVE_DOCUMENT_KEY_V1"):
            project = os.environ.get("CLOUDSQL_INSTANCE_CONNECTION_NAME", "").split(":", 1)[0]
            if not project or args.key_project not in {"backend", project}:
                raise RuntimeError("configuration_unavailable")
            _load_secrets(project, ("DRIVE_DOCUMENT_KEY_V1",))
        saved = json.loads(args.checkpoint.read_text(encoding="utf-8-sig"))
        content = open_checkpoint(saved)
        inventory = saved["inventory"]["rows"]
        rows = [
            content.project(
                row["id"], saved["items"][row["id"]], include_content=args.include_content
            )
            if row["id"] in saved["items"]
            else pending_rows([row])[0]
            for row in inventory
        ]
        if args.output:
            _write(args.output, csv_text(rows, columns=checkpoint_columns(saved)))
        print(
            json.dumps(
                {
                    "status": "validated",
                    "files": len(inventory),
                    "persisted": len(saved["items"]),
                    "pending": len(inventory) - len(saved["items"]),
                    "textStarts": sum(bool(item.get("text_start_chars")) for item in rows),
                    "embeddings": sum(bool(item.get("embedding_dimensions")) for item in rows),
                    "outputWritten": args.output is not None,
                }
            )
        )
        return 0
    except Exception as error:
        allowed = {"configuration_unavailable", "content_invalid", "output_exists"}
        print(
            json.dumps(
                {
                    "status": "error",
                    "code": str(error) if str(error) in allowed else "content_invalid",
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
