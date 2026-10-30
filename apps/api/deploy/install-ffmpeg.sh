#!/usr/bin/env bash
# Installs ffmpeg and ffprobe, which take the stills from customers' WhatsApp videos
# (src/channels/conversation.ts). Amazon Linux 2023 has no package for them, so this is the static
# build from github.com/BtbN/FFmpeg-Builds, checked against that release's checksums. Without them,
# WhatsApp videos still go through, just without the stills SAM counts on. Run it once on a server
# after bootstrap-ec2.sh, as root:
#
#   sudo bash /srv/quotient-api/current/apps/api/deploy/install-ffmpeg.sh
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=linux64 ;;
  aarch64) arch=linuxarm64 ;;
  *) echo "There's no ffmpeg build here for $(uname -m)." >&2; exit 1 ;;
esac
build="ffmpeg-master-latest-$arch-gpl"
base=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSLO "$base/$build.tar.xz"
curl -fsSLO "$base/checksums.sha256"
grep " $build.tar.xz\$" checksums.sha256 | sha256sum -c -
tar -xJf "$build.tar.xz"
install -m 755 "$build/bin/ffmpeg" "$build/bin/ffprobe" /usr/local/bin/
/usr/local/bin/ffmpeg -version | head -1
