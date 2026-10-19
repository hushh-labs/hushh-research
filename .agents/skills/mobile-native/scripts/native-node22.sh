# Source before the native JavaScript environment resolver, including nvm-only shells.
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v22'; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1090
    source "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null || return 1
  fi
fi
node -v | grep -q '^v22' || { echo "Node 22 is required for native builds." >&2; return 1; }
