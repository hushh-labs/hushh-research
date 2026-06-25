#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:-}"
EXPECTED_BACKEND_URL="${2:-}"

if [ -z "$CONFIG_PATH" ]; then
  if [ -n "${SRCROOT:-}" ]; then
    CONFIG_PATH="$SRCROOT/App/capacitor.config.json"
  else
    CONFIG_PATH="ios/App/App/capacitor.config.json"
  fi
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Missing Capacitor iOS config: $CONFIG_PATH" >&2
  echo "Run npm run cap:sync:ios after selecting the intended runtime profile." >&2
  exit 1
fi

python3 - "$CONFIG_PATH" "$EXPECTED_BACKEND_URL" <<'PY'
import json
import sys
from urllib.parse import urlparse

config_path = sys.argv[1]
expected_backend_url = (sys.argv[2] if len(sys.argv) > 2 else "").strip().rstrip("/")

plugin_names = [
    "HushhVault",
    "HushhConsent",
    "Kai",
    "HushhNotifications",
    "PersonalKnowledgeModel",
    "HushhAccount",
    "HushhSync",
]
loopback_hosts = {"localhost", "127.0.0.1", "0.0.0.0", "10.0.2.2"}

with open(config_path, "r", encoding="utf-8") as handle:
    config = json.load(handle)

plugins = config.get("plugins") or {}
urls = []
missing = []
for plugin_name in plugin_names:
    value = ((plugins.get(plugin_name) or {}).get("backendUrl") or "").strip().rstrip("/")
    if not value:
        missing.append(plugin_name)
    else:
        urls.append((plugin_name, value))

if missing:
    print(
        "Missing native backendUrl for plugin(s): " + ", ".join(missing),
        file=sys.stderr,
    )
    raise SystemExit(1)

bad = []
hosts = []
for plugin_name, value in urls:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    hosts.append(host or "(unparseable)")
    if not parsed.scheme or not host:
        bad.append(f"{plugin_name}={value}")
    elif host in loopback_hosts:
        bad.append(f"{plugin_name}={parsed.scheme}://{host}")

if bad:
    print(
        "Refusing iOS release archive with local native backend target(s): "
        + ", ".join(bad),
        file=sys.stderr,
    )
    print(
        "Run npm run ios:prepare:uat before archiving a UAT build.",
        file=sys.stderr,
    )
    raise SystemExit(1)

if expected_backend_url:
    mismatched = [
        f"{plugin_name}={value}" for plugin_name, value in urls if value != expected_backend_url
    ]
    if mismatched:
        print(
            "Bundled iOS backend does not match expected UAT backend for: "
            + ", ".join(mismatched),
            file=sys.stderr,
        )
        raise SystemExit(1)

unique_hosts = sorted(set(hosts))
print("iOS native backend verified: " + ", ".join(unique_hosts))
PY
