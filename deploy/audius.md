# Audius catalogue search

The VPS probe returned real search data and the beginning of an open audio
stream. This confirms connectivity and app credentials, not complete playback
or coverage of mainstream music. Audius is a separate catalogue.

## Deployment

Keep the existing `BOT_TOKEN` and profile functionality. Run as root:

```sh
cd /opt/wave
python3 scripts/configure-audius.py
systemctl restart wave
```

Enter only the API key and bearer-token values at the hidden prompts. The script
preserves unrelated `/etc/wave.env` settings and makes a root-only backup outside
the checkout. Do not include credentials in browser config, git or shell command
arguments. The bearer token is sent only to `https://api.audius.co`, and never to
redirected CDN hosts. Node HTTPS validates TLS and pins each connection to public
DNS addresses; private destinations and insecure redirects are rejected.

When both keys exist, the app shows “Найти музыку”. Profile search stays local;
the catalogue tab submits to `/api/search`. Search pagination and the playing
queue are independent, so changing the query or tab does not stop audio.

Search results use user-bound signed WAVE URLs. CDN URLs and credentials remain
server-side. References expire after two hours or a backend restart; repeat the
search afterward. Gated and non-streamable tracks are marked unavailable.

Direct audio uses the existing private disk cache and Range support. The
current file cap is 20 MiB. Files without a usable full Content-Length can use
the bounded direct fallback. Browser support and automatic transitions must be
checked in Telegram after deployment. No preview is represented as a full track.

The official SDK 17.0.0 README lists a Free plan of 10 requests/second and
500,000 requests/month; the service's current plan/account settings prevail.
This integration does not claim unlimited scale or a universal music catalogue.

## Development validation

```sh
node tests/audius.test.mjs
node tests/profile.test.mjs
node tests/audio-cache.test.mjs
node tests/http.test.mjs
```

Automated network tests use controlled responses. Live credentials are not in
the repository. The read-only `scripts/check-audius.py` can separately verify
credentials and initial audio bytes without saving keys.
