# Refuse a `gcloud secrets versions add` that would replace a protected list.
#
# Install once, per engineer:
#
#     echo 'source ~/Desktop/husshOne/scripts/ops/protected-secret-guard.sh' >> ~/.zshrc
#
# This is a guard, not a permission. Anyone can still run `command gcloud ...`
# and bypass it, and that is deliberate: a flat team should not need IAM tickets
# to do its job. What it removes is the ACCIDENT -- the case where someone means
# "add my number" and the tool silently means "replace everyone's".
#
# `gcloud secrets versions add` REPLACES the entire value. There is no append.
# On 2026-09-03 that took the UAT phone allowlist from 59 entries to 1, and it
# took five days to notice. See R35 and R36 in .claude/skills/safe-changes.

_hushh_protected_lists_file() {
  local root="${HUSHH_REPO_ROOT:-$HOME/Desktop/husshOne}"
  printf '%s/config/protected-lists.json' "$root"
}

_hushh_is_protected_secret() {
  local secret="$1" file
  file="$(_hushh_protected_lists_file)"
  [ -f "$file" ] || return 1
  python3 - "$file" "$secret" <<'PY' 2>/dev/null
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit(1)
names = {s["name"] for s in data.get("secrets", [])}
raise SystemExit(0 if sys.argv[2] in names else 1)
PY
}

gcloud() {
  # Only ever inspect `gcloud secrets versions add`. Everything else is
  # untouched and passes straight through.
  if [ "$1" = "secrets" ] && [ "$2" = "versions" ] && [ "$3" = "add" ]; then
    local arg secret=""
    for arg in "${@:4}"; do
      case "$arg" in
        -*) ;;                       # a flag, not the secret name
        *) [ -z "$secret" ] && secret="$arg" ;;
      esac
    done

    if [ -n "$secret" ] && _hushh_is_protected_secret "$secret"; then
      cat >&2 <<MSG

  REFUSED: ${secret} is a protected list.

  \`gcloud secrets versions add\` REPLACES the entire value. There is no
  append, so this would delete every entry you did not include -- silently,
  with no error. That is how 58 UAT test phone numbers were lost on
  2026-09-03.

  Use the tool that reads before it writes and cannot shrink a list:

    scripts/ops/secret_list_edit.py --secret ${secret} \\
      --project <PROJECT> --add <ENTRY> --apply

    scripts/ops/secret_list_edit.py --secret ${secret} \\
      --project <PROJECT> --restore-from <VERSION> --apply    # recover a wipe

  If you genuinely need to replace the whole value, that is a deliberate act:
  run it as \`command gcloud secrets versions add ...\` and say why in the PR
  or the incident channel.

MSG
      return 1
    fi
  fi
  command gcloud "$@"
}
