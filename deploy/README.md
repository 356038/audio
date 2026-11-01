# VPS deployment

Requires Node.js 22+ and a dedicated HTTPS hostname. The server serves both the
Mini App and the Telegram API; no Python, database or npm dependencies are needed.

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
```

The profile tests use fake Telegram responses, not real user files. Real API
availability and profile privacy must still be checked with the deployed bot.
Cloud Bot API downloads are capped at 20 MiB here; oversized files are shown as
unavailable. Streaming forwards Range requests; seek support also depends on
Telegram's upstream response. No permanent audio cache is kept. The loaded queue
is finite; pagination requires “Load more”. Refresh the library after signed
playback links expire or reopen the app after its one-hour login window expires.

No persistent user accounts, subscription billing or public catalogue are added.
