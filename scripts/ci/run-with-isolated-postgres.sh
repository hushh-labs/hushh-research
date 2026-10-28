#!/usr/bin/env bash
# Run a local verification command with its own attested PostgreSQL service.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 command [args...]" >&2
  exit 2
fi
repo_root="$(git rev-parse --show-toplevel)"
python="$repo_root/consent-protocol/.venv/bin/python"
pg_bin="${HUSHH_CI_TEST_PG_BIN:-$(pg_config --bindir)}"
[ -x "$python" ] && [ -x "$pg_bin/initdb" ] && [ -x "$pg_bin/pg_ctl" ] || {
  echo "Install the protocol Python environment and PostgreSQL server tools first." >&2
  exit 1
}
"$pg_bin/postgres" --version | grep -Eq '^postgres \(PostgreSQL\) 17\.' || {
  echo "Set HUSHH_CI_TEST_PG_BIN to PostgreSQL 17 server binaries." >&2
  exit 1
}
task_root="$(mktemp -d /tmp/hussh-ci-test-pg.XXXXXX)"
task_root="$(cd "$task_root" && pwd -P)"
task_start_attempted=0
task_pid=""
cleanup() {
  if [ "$task_start_attempted" = 1 ]; then
    if [ ! -f "$task_root/data/postmaster.pid" ]; then
      echo "Could not confirm the task-owned PostgreSQL shutdown; retained $task_root." >&2
      return 1
    fi
    observed_pid="$(sed -n '1p' "$task_root/data/postmaster.pid")"
    case "$observed_pid" in
      ''|0|*[!0-9]*) echo "Invalid PostgreSQL process identity; retained $task_root." >&2; return 1 ;;
    esac
    if [ "$(sed -n '2p' "$task_root/data/postmaster.pid")" != "$task_root/data" ] ||
       [ "$(sed -n '5p' "$task_root/data/postmaster.pid")" != "$task_root/socket" ] ||
       { [ -n "$task_pid" ] && [ "$observed_pid" != "$task_pid" ]; }; then
      echo "PostgreSQL ownership changed; retained $task_root." >&2
      return 1
    fi
    if kill -0 "$observed_pid" 2>/dev/null; then
      process_command="$(ps -p "$observed_pid" -o command=)"
      case "$process_command" in
        *"/postgres -D $task_root/data "*) ;;
        *) echo "PostgreSQL process identity changed; retained $task_root." >&2; return 1 ;;
      esac
      if ! "$pg_bin/pg_ctl" -D "$task_root/data" -m fast -w stop >/dev/null; then
        echo "Could not stop task-owned PostgreSQL; retained $task_root." >&2
        return 1
      fi
    fi
  fi
  rm -rf -- "$task_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$task_root/socket"

unset PGHOST PGHOSTADDR PGPORT PGUSER PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGDATABASE
unset ACCOUNT_DELETION_POSTGRES_URL AUDIT_TEST_DSN CHAT_CUTOVER_TEST_DATABASE_URL
unset CONTACT_SYNC_POSTGRES_TEST_URL EMAIL_AUTH_POLICY_DATABASE_URL FEED_IDENTITY_POSTGRES_TEST_URL
unset GOOGLE_OAUTH_TEST_DATABASE_URL PROFILE_BRIDGE_TEST_DSN PROFILE_PROJECTION_TEST_DSN
unset REFERRAL_TEST_DATABASE_URL SCOPE_COMMERCE_TEST_DSN
task_port="$("$python" - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
"$pg_bin/initdb" -D "$task_root/data" --auth=trust --no-locale --encoding=UTF8 >/dev/null
task_start_attempted=1
"$pg_bin/pg_ctl" -D "$task_root/data" -l "$task_root/postgres.log" \
  -o "-h 127.0.0.1 -k $task_root/socket -p $task_port -c fsync=off" -w start >/dev/null
task_pid="$(head -n 1 "$task_root/data/postmaster.pid")"
actual_data="$("$pg_bin/psql" -h "$task_root/socket" -p "$task_port" -d postgres -Atqc 'SHOW data_directory')"
[ "$actual_data" = "$task_root/data" ] || { echo "Unexpected PostgreSQL server." >&2; exit 1; }
"$pg_bin/createuser" -h "$task_root/socket" -p "$task_port" -s command_test
"$pg_bin/createdb" -h "$task_root/socket" -p "$task_port" -O command_test command_test
system_id="$("$pg_bin/psql" -h "$task_root/socket" -p "$task_port" -d postgres -Atqc 'SELECT system_identifier FROM pg_control_system()')"
umask 077
"$python" - "$task_root" "$task_port" "$task_pid" "$system_id" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
(root / "identity.json").write_text(json.dumps({
    "data_directory": str(root / "data"),
    "socket_directory": str(root / "socket"),
    "port": int(sys.argv[2]),
    "pid": int(sys.argv[3]),
    "system_identifier": sys.argv[4],
}))
PY
export ONE_COMMAND_TEST_PG_MANIFEST="$task_root/identity.json"
export ONE_COMMAND_TEST_DATABASE_URL="postgresql://command_test@127.0.0.1:$task_port/command_test"
(cd "$repo_root/consent-protocol" && PYTHONPATH=. "$python" -m tests.helpers.isolated_postgres)
"$@"
