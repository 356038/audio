# VPS deployment

Requires Node.js 22.13+ and a dedicated HTTPS hostname. The server serves both the
Mini App and the Telegram API; no Python, external database server or npm dependencies are needed. Personal
libraries use the SQLite engine bundled with Node.

Before deploying, inspect the VPS, existing projects, reverse proxy, available
ports and the actual Node path. Do not replace shared proxy configuration or
restart unrelated services. Keep this app in its own directory and service.

1. Place the checkout in `/opt/wave` and use a dedicated `wave` service user.
2. Store configuration outside the checkout in `/etc/wave.env`, readable only by
   root. Set `BOT_TOKEN` to the token of `@wave_audio_player_bot`, and
   `FRONTEND_ORIGIN` to the final HTTPS origin with no trailing slash. Set
   `HOST=127.0.0.1`, `PORT=8787` after verifying that the port is available.
3. Adapt `wave.service` to the actual paths, install it as a new service, and
   start it. For a local smoke test with variables already injected, use
   `node backend.mjs`. Merely starting Node does not validate Telegram access.
4. Add a dedicated reverse-proxy site. `Caddyfile.example` shows one possible
   configuration; use the VPS's existing proxy and validate its configuration
   before reloading. Do not install a competing proxy on occupied ports.
5. Verify `/health`, HTML, JS, playback and an authenticated profile request.
6. Set this HTTPS site as the menu-button URL in BotFather. Open the app from the
   bot, verify your real profile list, play a track, then test a locked screen.

The existing GitHub Pages site remains a static deployment. Its `docs/config.js`
has no backend address until deliberately configured. For a split deployment,
set that public address there and adapt the API's allowed frontend origin
separately; the default VPS deployment serves everything on one HTTPS origin.

Do not expose the Telegram token in Pages, query strings, git, screenshots or
logs. Signed playback URLs are temporary bearer links; anyone holding one can
play its file until it expires (two hours). They are not the bot token. Do not
publish these links or index users' libraries for others.

## Themes

Set `WAVE_THEME=default` for the base appearance or `WAVE_THEME=halloween` for
the seasonal appearance, then restart only WAVE. Halloween is the default.

## Validation

```sh
node tests/profile.test.mjs
node tests/http.test.mjs
node tests/audio-cache.test.mjs
node tests/audius.test.mjs
node tests/personal.test.mjs
```

The profile tests use fake Telegram responses, not real user files. Real API
availability and profile privacy must still be checked with the deployed bot.
Cloud Bot API downloads are capped at 20 MiB here; oversized files are shown as
unavailable. The private disk cache serves byte ranges locally, including while a file is
still downloading. Audio is retained up to two hours with cleanup every minute,
with a total budget of 256 MiB and at most three simultaneous cache downloads.
Only signed requests can read audio; the cache is not a public static directory. The loaded queue
is finite; pagination requires “Load more”. Refresh the library after signed
playback links expire or reopen the app after its one-hour login window expires.

Personal libraries and recent listening history are stored in
`$STATE_DIRECTORY/library.sqlite` (`/var/lib/wave/library.sqlite` in this service).
`WAVE_DATA_DIR` overrides the database directory. Preserve this database separately
from the disposable audio cache. Back up with SQLite backup tooling, or stop WAVE
before copying the database directory. Never expose it as a static directory.
No subscription billing is implemented.

## Updating an existing service for the audio cache

Install `deploy/cache.conf` as `/etc/systemd/system/wave.service.d/cache.conf`,
then run `systemctl daemon-reload` and restart only WAVE. It adds a private
`StateDirectory=wave`, writable under the existing hardening settings. The
server stores audio in `$STATE_DIRECTORY/wave-audio-cache`. If no state directory
is configured, the fallback is the service-private temporary directory.
`WAVE_CACHE_DIR` can override the location; do not point it at a shared folder.
`WAVE_CACHE_DISABLED=1` disables the disk cache for troubleshooting. If cache
storage fails, playback falls back to the Telegram proxy.

Run `python3 scripts/check-audio.py` after playing a track to measure two local
Range requests. `HIT` means a completed local file, `FILL` means progressive
download, and `BYPASS` means the direct Telegram fallback. No tokens or signed
URLs are printed. Local measurements exclude the phone's network.
