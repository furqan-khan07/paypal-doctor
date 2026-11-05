#!/usr/bin/env bash
# Merges your recorded voiceover with the captured footage into an upload-ready MP4.
#
#   npm run video:merge -- path/to/voiceover.m4a
#
# If the voiceover runs longer than the footage, the last frame is held. If it runs
# shorter, the video is trimmed to the voiceover plus a second. Refuses to go past
# 2:59, because the rules ask for under 3 minutes.
set -euo pipefail

cd "$(dirname "$0")/../.."
VOICE="${1:-}"
BIN="${FFMPEG_DIR:-/opt/anaconda3/envs/paypal-doctor-video/bin}"
FOOTAGE="video/footage.mp4"
OUT="video/paypal-doctor.mp4"
LIMIT=179

if [ -z "$VOICE" ] || [ ! -f "$VOICE" ]; then
  echo "usage: npm run video:merge -- path/to/voiceover.m4a" >&2
  exit 2
fi
if [ ! -f "$FOOTAGE" ]; then
  echo "No $FOOTAGE yet. Run: npm run video:capture" >&2
  exit 2
fi

dur() { "$BIN/ffprobe" -v error -show_entries format=duration -of default=nw=1:nk=1 "$1"; }
V=$(dur "$VOICE")
F=$(dur "$FOOTAGE")

read -r LENGTH PAD <<<"$(python3 -I -c "
v, f = float('$V'), float('$F')
length = v + 1 if v + 1 < f else max(v + 0.5, f)
print(f'{length:.2f} {max(0.0, length - f):.2f}')
")"

echo "voiceover ${V%.*}s, footage ${F%.*}s, output ${LENGTH%.*}s"
if python3 -I -c "import sys; sys.exit(0 if float('$V') + 5 < float('$F') else 1)"; then
  echo "Note: the voiceover is much shorter than the footage, so the last shots get cut. Check that's what you want."
fi
if python3 -I -c "import sys; sys.exit(0 if float('$LENGTH') > $LIMIT else 1)"; then
  echo "That's over 2:59. Trim the voiceover: the rules ask for under 3 minutes." >&2
  exit 1
fi

"$BIN/ffmpeg" -y -hide_banner -loglevel error -i "$FOOTAGE" -i "$VOICE" \
  -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=${PAD},fps=24,format=yuv420p[v];[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]" \
  -map "[v]" -map "[a]" -t "$LENGTH" \
  -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k -movflags +faststart "$OUT"

"$BIN/ffprobe" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$OUT" | sed 's/^/size: /'
dur "$OUT" | sed 's/^/length (s): /'
echo "Wrote $OUT. Watch all of it before you upload it."
