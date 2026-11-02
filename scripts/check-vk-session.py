"""Read-only VK web-search probe. Credentials stay in terminal memory only."""
import argparse
import getpass
import html
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import warnings

MAX_BODY = 2 * 1024 * 1024


class ProbeError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def cookie_header(raw):
    raw = raw.strip()
    if raw.lower().startswith('cookie:'):
        raw = raw[7:].strip()
    if not raw or len(raw) > 32768 or any(ord(c) < 32 or ord(c) > 126 for c in raw):
        raise ProbeError('Нужна одна строка Cookie из браузера. Ничего не отправлено.')
    pairs = raw.split(';')
    if any(not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-zA-Z-]+=[^;]*", pair.strip()) for pair in pairs):
        raise ProbeError('Неверный формат Cookie. Вставляйте только значение этого заголовка.')
    return raw


def account_id(page):
    # Only VK's explicit current-user object; never arbitrary track owners/IDs.
    for pattern in [r'\bvk\.id\s*=\s*([1-9][0-9]{0,14})\b',
                    r'\b(?:var\s+)?vk\s*=\s*\{([^{}]{0,8192})\}']:
        match = re.search(pattern, page)
        if match:
            value = match.group(1)
            if value.isdigit():
                return int(value)
            identity = re.search(r'''(?:^|,)\s*["']?id["']?\s*:\s*([1-9][0-9]{0,14})\b''', value)
            if identity:
                return int(identity.group(1))
    return None


def label(value):
    value = html.unescape(re.sub(r'<[^>]*>', '', str(value)))
    return ''.join(c for c in value if not unicodedata.category(c).startswith('C'))[:180]


def search_rows(body):
    try:
        value = json.loads(body.removeprefix('<!--').strip())
    except (ValueError, TypeError):
        raise ProbeError('VK вернул страницу вместо списка. Возможны проверка входа или изменение веб-интерфейса.') from None
    try:
        payload = value['payload']
        if payload[0] not in (0, '0'):
            raise ProbeError('VK не разрешил поиск этой сессии. Проверку входа нужно пройти в браузере.')
        playlist = payload[1][1]['playlist']
        rows = [] if playlist is None else playlist['list']
        if not isinstance(rows, list):
            raise ValueError()
    except (KeyError, IndexError, TypeError, ValueError):
        raise ProbeError('Формат ответа VK отличается от ожидаемого. Доступ к поиску не подтверждён.') from None
    tracks = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue
        if not isinstance(row[3], str) or not isinstance(row[4], str):
            continue
        duration = row[5] if isinstance(row[5], (int, float)) and not isinstance(row[5], bool) else 0
        tracks.append({'artist': label(row[4]), 'title': label(row[3]), 'duration': duration})
    if rows and not tracks:
        raise ProbeError('Получены данные неизвестного формата. Поиск не подтверждён.')
    return tracks


class SessionProbe:
    def __init__(self, host, cookie, opener=None):
        if host not in ('vk.ru', 'vk.com'):
            raise ProbeError('Разрешены только vk.ru и vk.com.')
        self.origin = 'https://' + host
        self.cookie = cookie_header(cookie)
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, path, data=None):
        if path not in ('/audio', '/al_audio.php'):
            raise ProbeError('Недопустимый адрес проверки.')
        encoded = None if data is None else urllib.parse.urlencode(data).encode()
        headers = {'Cookie': self.cookie, 'User-Agent': 'WAVE-session-check/1.0',
                   'Accept-Encoding': 'identity', 'Referer': self.origin + '/audio'}
        if encoded is not None:
            headers.update({'Content-Type': 'application/x-www-form-urlencoded',
                            'X-Requested-With': 'XMLHttpRequest', 'Origin': self.origin})
        request = urllib.request.Request(self.origin + path, encoded, headers)
        try:
            with self.opener.open(request, timeout=25) as response:
                if response.status != 200:
                    raise ProbeError('VK не вернул успешный ответ.')
                body = response.read(MAX_BODY + 1)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            if 300 <= status < 400:
                raise ProbeError('VK перенаправляет запрос. Откройте музыку в браузере и используйте Cookie и --host того же сайта; перенаправления не выполнялись.') from None
            if status in (401, 403, 429):
                raise ProbeError(f'HTTP {status}: доступ ограничен. Автоматических повторов не было.') from None
            raise ProbeError(f'Сервер вернул HTTP {status}. Значения сессии не выводились.') from None
        except (OSError, urllib.error.URLError):
            raise ProbeError('Не удалось связаться с VK. Детали запроса скрыты, сессия не выводилась.') from None
        if len(body) > MAX_BODY:
            raise ProbeError('Ответ VK превышает 2 МиБ. Чтение остановлено.')
        return body.decode('utf-8', 'replace')

    def search(self, query, user_id):
        return search_rows(self.request('/al_audio.php', {
            'al': 1, 'act': 'section', 'claim': 0, 'is_layer': 0,
            'owner_id': user_id, 'section': 'search', 'q': query,
        }))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=['vk.ru', 'vk.com'], default='vk.ru')
    parser.add_argument('--user-id', type=int)
    parser.add_argument('--query', default='Queen')
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise ProbeError('Запустите в интерактивном терминале: скрытый ввод обязателен.')
    if not args.query.strip() or len(args.query) > 200:
        raise ProbeError('Запрос должен содержать от 1 до 200 символов.')
    if args.user_id is not None and not 0 < args.user_id < 10**15:
        raise ProbeError('Нужен положительный числовой ID вашего аккаунта.')
    print('Проверка только поиска. Cookie не сохраняется; пароль и коды не нужны.')
    print('Берите Cookie запроса к тому же сайту, который указан в --host.')
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        secret = getpass.getpass('Cookie VK (ввод скрыт): ')
    probe = SessionProbe(args.host, secret)
    del secret
    user_id = args.user_id or account_id(probe.request('/audio'))
    if not user_id:
        raise ProbeError('Не удалось определить ID текущего аккаунта. Перезапустите с --user-id ЧИСЛОВОЙ_ID. Если VK просит войти, сначала войдите в браузере.')
    tracks = probe.search(args.query, user_id)
    print('Ответ поиска получен. Треков на странице:', len(tracks))
    for track in tracks[:8]:
        print(json.dumps(track, ensure_ascii=False))
    print('Воспроизведение ещё не проверено. Настройки WAVE не изменены. Сессия на диск не записывалась.')


if __name__ == '__main__':
    try:
        main()
    except (ProbeError, EOFError, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, ProbeError) else 'Проверка остановлена.', file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Never print provider bodies, request objects, cookies or tracebacks.
        print('Проверка не завершена. Секреты и ответ VK не выводились.', file=sys.stderr)
        sys.exit(1)
