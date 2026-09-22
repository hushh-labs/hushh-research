#!/bin/zsh
# Count dropped frames in a screen recording, for the comparison a profiler
# cannot make: native Threads (an App Store binary Instruments cannot attach
# to) against our app, on the same phone, doing the same gesture.
#
#   scripts/perf/video-frame-drops.sh <recording.mov|mp4> [label]
#
# The phone's own screen recording captures at the display rate. A frame the
# app failed to deliver shows up as a repeat of the previous one; ffmpeg's
# mpdecimate drops such repeats, so "kept / total" is the delivered-frame
# ratio, and the longest run of repeats is the worst stall. Apply it to both
# recordings identically; the method is crude but symmetric. It reads pixels
# only and stores nothing but the numbers.
set -euo pipefail
INPUT="${1:?recording path}"
LABEL="${2:-$(basename "$INPUT")}"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

FPS="$(ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of csv=p=0 "$INPUT")"
TOTAL="$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$INPUT")"
# hi/lo thresholds tuned for UI content: a repeat is a frame almost identical to the last.
# Frames that survive decimation, counted one showinfo line each.
KEPT="$(ffmpeg -v info -i "$INPUT" -vf "mpdecimate=hi=64*12:lo=64*5:frac=0.33,showinfo" -an -f null - 2>&1 | grep -c "Parsed_showinfo.* n:" || true)"
KEPT="${KEPT:-0}"
# Longest run of repeated frames: mpdecimate reports a running drop_count per
# frame (positive while it keeps dropping), so its maximum is the worst stall.
LONGEST="$(ffmpeg -v debug -i "$INPUT" -vf "mpdecimate=hi=64*12:lo=64*5:frac=0.33" -an -f null - 2>&1 \
  | grep -o "drop_count:[0-9]*" | cut -d: -f2 | sort -n | tail -1)"
LONGEST="${LONGEST:-0}"
python3 - "$LABEL" "$FPS" "$TOTAL" "$KEPT" "$LONGEST" <<'PY'
import sys
label, fps, total, kept, longest = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
num, den = (fps.split("/") + ["1"])[:2]
rate = float(num) / float(den or 1)
repeats = max(0, total - kept)
print(f"{label}: {total} frames at {rate:.0f} fps, {kept} delivered ({kept / max(1, total) * 100:.1f}%), {repeats} repeated, worst stall ~{longest / max(rate, 1) * 1000:.0f} ms ({longest} frames)")
PY
