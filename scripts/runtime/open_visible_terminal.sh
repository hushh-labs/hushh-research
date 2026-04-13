#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/runtime/open_visible_terminal.sh --cwd <path> --title <title> -- <command> [args...]

Opens a visible OS terminal window and runs the requested command there.

Environment:
  HUSHH_VISIBLE_TERMINAL_APP   Optional terminal preference (for example: terminal, iterm, gnome-terminal, konsole, kitty, wt)
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

require_gui_display() {
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    die "No graphical display detected. Use the direct ./bin/hushh commands in the current shell instead."
  fi
}

detect_os() {
  case "$(uname -s)" in
    Darwin)
      echo "darwin"
      ;;
    Linux)
      if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "windows"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

PREFERRED_TERMINAL="${HUSHH_VISIBLE_TERMINAL_APP:-}"
PREFERRED_TERMINAL_LOWER="$(printf '%s' "$PREFERRED_TERMINAL" | tr '[:upper:]' '[:lower:]')"
CWD=""
TITLE="Hushh terminal"
COMMAND_ARGS=()

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --cwd)
      CWD="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --)
      shift
      COMMAND_ARGS=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[ -n "$CWD" ] || die "--cwd is required"
[ "${#COMMAND_ARGS[@]}" -gt 0 ] || die "Command is required after --"

mkdir -p "${TMPDIR:-/tmp}"
LAUNCHER_BASE="$(mktemp "${TMPDIR:-/tmp}/hushh-visible-terminal.XXXXXX")"
LAUNCHER_SCRIPT="${LAUNCHER_BASE}.sh"
mv "$LAUNCHER_BASE" "$LAUNCHER_SCRIPT"
chmod +x "$LAUNCHER_SCRIPT"

printf -v COMMAND_STRING '%q ' "${COMMAND_ARGS[@]}"
COMMAND_STRING="${COMMAND_STRING% }"

cat >"$LAUNCHER_SCRIPT" <<EOF
#!/usr/bin/env bash
set -uo pipefail
cd $(printf '%q' "$CWD")
printf '\\033]0;%s\\007' $(printf '%q' "$TITLE") >/dev/null 2>&1 || true
${COMMAND_STRING}
status=\$?
echo
if [ "\$status" -eq 0 ]; then
  echo "[hushh terminal] Command finished successfully."
else
  echo "[hushh terminal] Command exited with status \$status."
fi
echo "[hushh terminal] Leaving shell open in $(printf '%q' "$CWD")."
rm -f -- "\$0" >/dev/null 2>&1 || true
exec "\${SHELL:-/bin/bash}" -l
EOF

launch_macos_terminal() {
  osascript <<EOF
tell application "Terminal"
  activate
  do script "bash $(printf '%q' "$LAUNCHER_SCRIPT")"
end tell
EOF
}

launch_macos_iterm() {
  osascript <<EOF
tell application "iTerm"
  activate
  create window with default profile
  tell current session of current window
    write text "bash $(printf '%q' "$LAUNCHER_SCRIPT")"
  end tell
end tell
EOF
}

launch_linux_terminal() {
  require_gui_display
  case "$PREFERRED_TERMINAL_LOWER" in
    ""|auto) ;;
    gnome-terminal)
      command -v gnome-terminal >/dev/null 2>&1 || die "Preferred terminal gnome-terminal is not installed."
      gnome-terminal -- bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
      return
      ;;
    konsole)
      command -v konsole >/dev/null 2>&1 || die "Preferred terminal konsole is not installed."
      konsole --noclose -e bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
      return
      ;;
    kitty)
      command -v kitty >/dev/null 2>&1 || die "Preferred terminal kitty is not installed."
      kitty --hold bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
      return
      ;;
    wezterm)
      command -v wezterm >/dev/null 2>&1 || die "Preferred terminal wezterm is not installed."
      wezterm start -- bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
      return
      ;;
    x-terminal-emulator)
      command -v x-terminal-emulator >/dev/null 2>&1 || die "Preferred terminal x-terminal-emulator is not installed."
      x-terminal-emulator -e bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
      return
      ;;
    *)
      die "Unsupported HUSHH_VISIBLE_TERMINAL_APP for Linux: $PREFERRED_TERMINAL"
      ;;
  esac

  if command -v x-terminal-emulator >/dev/null 2>&1; then
    x-terminal-emulator -e bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
  elif command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal -- bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
  elif command -v konsole >/dev/null 2>&1; then
    konsole --noclose -e bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
  elif command -v xfce4-terminal >/dev/null 2>&1; then
    xfce4-terminal --hold --command "bash $(printf '%q' "$LAUNCHER_SCRIPT")" >/dev/null 2>&1 &
  elif command -v mate-terminal >/dev/null 2>&1; then
    mate-terminal -- bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
  elif command -v kitty >/dev/null 2>&1; then
    kitty --hold bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
  elif command -v wezterm >/dev/null 2>&1; then
    wezterm start -- bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
  elif command -v xterm >/dev/null 2>&1; then
    xterm -hold -e bash "$LAUNCHER_SCRIPT" >/dev/null 2>&1 &
  else
    die "No supported Linux terminal launcher found. Try setting HUSHH_VISIBLE_TERMINAL_APP or run the command directly."
  fi
}

launch_wsl_or_windows() {
  if command -v wt.exe >/dev/null 2>&1; then
    if [ "$(detect_os)" = "wsl" ]; then
      wt.exe new-tab --title "$TITLE" wsl.exe bash -lc "bash $(printf '%q' "$LAUNCHER_SCRIPT")" >/dev/null 2>&1 &
    else
      wt.exe new-tab --title "$TITLE" bash -lc "bash $(printf '%q' "$LAUNCHER_SCRIPT")" >/dev/null 2>&1 &
    fi
    return
  fi

  if command -v cmd.exe >/dev/null 2>&1; then
    if [ "$(detect_os)" = "wsl" ]; then
      cmd.exe /c start "" wsl.exe bash -lc "bash $(printf '%q' "$LAUNCHER_SCRIPT")" >/dev/null 2>&1 &
    else
      cmd.exe /c start "" bash -lc "bash $(printf '%q' "$LAUNCHER_SCRIPT")" >/dev/null 2>&1 &
    fi
    return
  fi

  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process powershell -ArgumentList '-NoExit','-Command','bash $(printf "%q" "$LAUNCHER_SCRIPT")'" >/dev/null 2>&1 &
    return
  fi

  die "No supported Windows terminal launcher found. Run the command directly in your terminal."
}

case "$(detect_os)" in
  darwin)
    case "$PREFERRED_TERMINAL_LOWER" in
      ""|auto|terminal)
        launch_macos_terminal
        ;;
      iterm|iterm2)
        launch_macos_iterm
        ;;
      *)
        die "Unsupported HUSHH_VISIBLE_TERMINAL_APP for macOS: $PREFERRED_TERMINAL"
        ;;
    esac
    ;;
  linux)
    launch_linux_terminal
    ;;
  wsl|windows)
    launch_wsl_or_windows
    ;;
  *)
    die "Unsupported operating system: $(uname -s)"
    ;;
esac

echo "Opened visible terminal window for: ${COMMAND_ARGS[*]}"
