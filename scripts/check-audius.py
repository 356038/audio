"""Read-only Audius connectivity check. Secrets are prompted locally, not saved."""
import getpass
import ipaddress
import json
import socket
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.audius.co'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_https(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Unsupported redirect')
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise ValueError('Non-public redirect')


def request(url, bearer, *, stream=False):
    opener = urllib.request.build_opener(NoRedirect)
    for _ in range(6):
        public_https(url)
        headers = {'User-Agent': 'WAVE-catalog-check/1.0'}
        # Credentials go only to Audius's API, never to a redirected CDN host.
        if urllib.parse.urlsplit(url).netloc == 'api.audius.co':
            headers['Authorization'] = 'Bearer ' + bearer
        if stream:
            headers['Range'] = 'bytes=0-1023'
        try:
            response = opener.open(urllib.request.Request(url, headers=headers), timeout=30)
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise
            location = error.headers.get('Location')
            error.close()
            if not location:
                raise ValueError('Missing redirect')
            url = urllib.parse.urljoin(url, location)
            continue
        return response
    raise ValueError('Redirect limit')


def main():
    api_key = getpass.getpass('API Key Audius (ввод скрыт): ').strip()
    bearer = getpass.getpass('Bearer Token Audius (ввод скрыт): ').strip()
    if any(not key or len(key) > 8192 or any(c.isspace() or not c.isprintable() for c in key) for key in (api_key, bearer)):
        raise SystemExit('Неверный формат ключей. Ничего не сохранено.')
    query = urllib.parse.urlencode({'query': 'electronic', 'limit': 5, 'app_name': 'WAVE', 'api_key': api_key})
    with request(API + '/v1/tracks/search?' + query, bearer) as response:
        print('Поиск: HTTP', response.status)
        raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Response limit')
        result = json.loads(raw)
    tracks = result.get('data')
    if not isinstance(tracks, list):
        raise ValueError('Unexpected response')
    print('Найдено в этой выдаче:', len(tracks))
    selected = None
    for track in tracks:
        if not isinstance(track, dict):
            continue
        print(json.dumps({'title': track.get('title'), 'artist': (track.get('user') or {}).get('name'),
                          'gated': bool(track.get('is_stream_gated'))}, ensure_ascii=False))
        track_id = track.get('id')
        if selected is None and isinstance(track_id, str) and track_id.isalnum() and not track.get('is_stream_gated') and track.get('is_streamable') is not False:
            selected = track_id
    if not selected:
        print('В этой выдаче нет открытого трека для проверки аудио. Готовность не подтверждена.')
        return
    stream_query = urllib.parse.urlencode({'app_name': 'WAVE', 'api_key': api_key})
    with request(API + '/v1/tracks/' + selected + '/stream?' + stream_query, bearer, stream=True) as response:
        chunk = response.read(1024)
        print('Аудио: HTTP', response.status)
        print('Content-Type:', response.headers.get('Content-Type', 'не указан'))
        print('Прочитано байт:', len(chunk))
        kind = response.headers.get_content_type()
        if not chunk or kind in ('application/json', 'text/html'):
            print('Аудио не подтверждено: нужен анализ ответа сервиса.')
        else:
            print('Начало потока доступно. Реальное воспроизведение в WAVE ещё нужно проверить.')


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print('Проверка остановлена: HTTP', error.code)
        print('Server:', error.headers.get('Server', 'не указан'))
        print('Content-Type:', error.headers.get('Content-Type', 'не указан'))
        # Never dump provider bodies or URLs: they can reflect credentials.
        if error.code in (401, 403):
            print('Нужно проверить ключи, доступ API и возможную блокировку IP/региона.')
    except (OSError, ValueError, KeyError, TypeError):
        print('Проверка не завершена: сетевой сбой или неожиданный ответ. Ключи не выводились.')
