#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'Запустите этот скрипт от root на VPS WAVE.' >&2
  exit 1
fi
WAVE_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WAVE_REPO_DIR"

node tests/audio-cache.test.mjs
node tests/profile.test.mjs
node tests/http.test.mjs

WAVE_DROPIN=/etc/systemd/system/wave.service.d/cache.conf
if [ -e "$WAVE_DROPIN" ] && ! cmp -s deploy/cache.conf "$WAVE_DROPIN"; then
  echo 'Существующий cache.conf отличается. Ничего не перезаписано.' >&2
  exit 1
fi
systemctl cat wave.service >/dev/null
install -d -m 755 /etc/systemd/system/wave.service.d
install -m 644 deploy/cache.conf "$WAVE_DROPIN"
systemctl daemon-reload
systemctl restart wave.service
curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 1 \
  https://wave-player-test.duckdns.org/health
