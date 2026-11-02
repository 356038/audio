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
    def __init__(self, message, diagnostic=None):
        super().__init__(message)
        self.diagnostic = diagnostic


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


def browser_agent(raw):
    raw = raw.strip()
    if raw.lower().startswith('user-agent:'):
        raw = raw[len('user-agent:'):].strip()
    if not raw.startswith('Mozilla/') or not 20 <= len(raw) <= 2048 or any(ord(c) < 32 or ord(c) > 126 for c in raw):
        raise ProbeError('Нужно значение User-Agent вашего браузера. Cookie вводится отдельно; ничего не отправлено.')
    return raw


def account_id(page):
    # Only VK's explicit current-user object; never arbitrary track owners/IDs.
    for pattern in [r'\bvk\.id\s*=\s*(0|[1-9][0-9]{0,14})\b',
                    r'\b(?:var\s+)?vk\s*=\s*\{([^{}]{0,8192})\}']:
        match = re.search(pattern, page)
        if match:
            value = match.group(1)
            if value.isdigit():
                return int(value)
            identity = re.search(r'''(?:^|,)\s*["']?id["']?\s*:\s*(0|[1-9][0-9]{0,14})\b''', value)
            if identity:
                return int(identity.group(1))
    return None


def label(value):
    value = html.unescape(re.sub(r'<[^>]*>', '', str(value)))
    return ''.join(c for c in value if not unicodedata.category(c).startswith('C'))[:180]


def response_shape(value):
    """Only fixed labels and a bounded numeric status; never provider strings."""
    def kind(item):
        return {dict: 'object', list: 'array', str: 'string', int: 'integer',
                float: 'number', bool: 'boolean', type(None): 'null'}.get(type(item), 'other')
    result = {'root_type': kind(value)}
    if not isinstance(value, dict):
        return result
    result['has_error'] = 'error' in value
    payload = value.get('payload')
    result['payload_type'] = kind(payload)
    if not isinstance(payload, list):
        return result
    result['payload_types'] = [kind(item) for item in payload[:6]]
    code = payload[0] if payload else None
    if isinstance(code, str) and re.fullmatch(r'-?[0-9]{1,5}', code):
        code = int(code)
    result['payload_code'] = code if type(code) is int and abs(code) < 100000 else 'unknown'
    if len(payload) > 1 and isinstance(payload[1], list):
        reply = payload[1]
        result['reply_types'] = [kind(item) for item in reply[:6]]
        result['has_playlist'] = any(isinstance(item, dict) and 'playlist' in item for item in reply[:6])
    return result


def search_rows(body):
    try:
        value = json.loads(body.removeprefix('<!--').strip())
    except (ValueError, TypeError):
        raise ProbeError('VK вернул страницу вместо списка. Возможны проверка входа или изменение веб-интерфейса.') from None
    try:
        payload = value['payload']
        if payload[0] not in (0, '0'):
            raise ProbeError('VK вернул ненулевой код веб-запроса. Причина не установлена; это ещё не подтверждает необходимость повторного входа.', response_shape(value))
        playlist = payload[1][1]['playlist']
        rows = [] if playlist is None else playlist['list']
        if not isinstance(rows, list):
            raise ValueError()
    except (KeyError, IndexError, TypeError, ValueError):
        raise ProbeError('Формат ответа VK отличается от ожидаемого. Доступ к поиску не подтверждён.', response_shape(value)) from None
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


def redirect_target(origin, current, location):
    """Classify without exposing a Location's query/hash; approve only music GETs."""
    diagnostic = {'target_host': 'other', 'route': 'other', 'same_origin': False}
    if not isinstance(location, str) or len(location) > 8192 or any(ord(c) < 32 for c in location):
        return diagnostic, None
    try:
        target = urllib.parse.urlsplit(urllib.parse.urljoin(current, location))
        host = target.hostname
        if host in ('vk.ru', 'vk.com', 'm.vk.ru', 'm.vk.com', 'id.vk.ru', 'id.vk.com', 'login.vk.ru', 'login.vk.com'):
            diagnostic['target_host'] = host
        diagnostic['same_origin'] = (target.scheme == 'https' and host == urllib.parse.urlsplit(origin).hostname
                                     and target.port in (None, 443) and not target.username and not target.password)
        path = target.path.lower()
        if re.match(r'^/(?:challenge|captcha|429|security_check)(?:[/.]|$)', path):
            diagnostic['route'] = 'challenge'
        elif host in ('id.vk.ru', 'id.vk.com', 'login.vk.ru', 'login.vk.com') or re.match(r'^/(?:login|auth|join)(?:[/.]|$)', path):
            diagnostic['route'] = 'login'
        elif re.fullmatch(r'/(?:audio|music|audios[1-9][0-9]{0,14})/?', target.path):
            diagnostic['route'] = 'music'
        parameters = urllib.parse.parse_qsl(target.query, keep_blank_values=True, max_num_fields=8)
        safe_query = all((key == 'q' and len(value) <= 200 and all(ord(c) >= 32 for c in value)) or
                         (key == 'section' and value in ('all', 'my', 'search')) for key, value in parameters)
        if diagnostic['same_origin'] and diagnostic['route'] == 'music' and safe_query:
            return diagnostic, urllib.parse.urlunsplit(('https', urllib.parse.urlsplit(origin).netloc, target.path, target.query, ''))
    except (ValueError, TypeError):
        pass
    return diagnostic, None


class SessionProbe:
    def __init__(self, host, cookie, opener=None, user_agent=None):
        if host not in ('vk.ru', 'vk.com'):
            raise ProbeError('Разрешены только vk.ru и vk.com.')
        self.origin = 'https://' + host
        self.cookie = cookie_header(cookie)
        self.user_agent = browser_agent(user_agent) if user_agent is not None else 'WAVE-session-check/1.0'
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        names = {pair.strip().partition('=')[0] for pair in self.cookie.split(';')}
        self.diagnostic = {'cookie_presence': {name: name in names for name in ('remixsid', 'remixsid6', 'remixnsid')},
                           'browser_agent_provided': user_agent is not None}

    def request(self, path, data=None, _redirect_url=None, _hops=0):
        if path not in ('/audio', '/al_audio.php') and not re.fullmatch(r'/audios[1-9][0-9]{0,14}', path):
            raise ProbeError('Недопустимый адрес проверки.')
        encoded = None if data is None else urllib.parse.urlencode(data).encode()
        headers = {'Cookie': self.cookie, 'User-Agent': self.user_agent,
                   'Accept-Encoding': 'identity', 'Referer': self.origin + '/audio'}
        if encoded is not None:
            headers.update({'Content-Type': 'application/x-www-form-urlencoded',
                            'X-Requested-With': 'XMLHttpRequest', 'Origin': self.origin})
        request = urllib.request.Request(_redirect_url or self.origin + path, encoded, headers)
        try:
            with self.opener.open(request, timeout=25) as response:
                if response.status != 200:
                    raise ProbeError('VK не вернул успешный ответ.')
                body = response.read(MAX_BODY + 1)
        except urllib.error.HTTPError as error:
            status = error.code
            location = error.headers.get('Location')
            error.close()
            if 300 <= status < 400:
                detail, target = redirect_target(self.origin, request.full_url, location)
                detail.update({'status': status, 'stage': 'music_page' if data is None else 'search'})
                self.diagnostic.setdefault('redirects', []).append(detail)
                if status in (301, 302, 303, 307, 308) and data is None and target and _hops < 2:
                    return self.request(path, _redirect_url=target, _hops=_hops + 1)
                if detail['route'] == 'login':
                    message = 'VK перенаправляет серверный запрос на вход. Сессия браузера пока не принята сервером; перенаправление на вход не выполнялось.'
                elif detail['route'] == 'challenge':
                    message = 'VK перенаправляет на проверку безопасности. Проверка остановлена.'
                else:
                    message = 'Перенаправление VK остановлено: другой сайт, неизвестный маршрут или предел переходов. Направление указано в диагностике без секретных ссылок.'
                raise ProbeError(message, self.diagnostic) from None
            if status in (401, 403, 429):
                raise ProbeError(f'HTTP {status}: доступ ограничен. Автоматических повторов не было.') from None
            raise ProbeError(f'Сервер вернул HTTP {status}. Значения сессии не выводились.') from None
        except (OSError, urllib.error.URLError):
            raise ProbeError('Не удалось связаться с VK. Детали запроса скрыты, сессия не выводилась.') from None
        if len(body) > MAX_BODY:
            raise ProbeError('Ответ VK превышает 2 МиБ. Чтение остановлено.')
        return body.decode('utf-8', 'replace')

    def search(self, query, user_id):
        try:
            return search_rows(self.request('/al_audio.php', {
                'al': 1, 'act': 'section', 'claim': 0, 'is_layer': 0,
                'owner_id': user_id, 'section': 'search', 'q': query,
            }))
        except ProbeError as error:
            error.diagnostic = {**self.diagnostic, **(error.diagnostic or {})}
            raise

    def check_account(self, expected=None):
        try:
            actual = account_id(self.request('/audios' + str(expected) if expected else '/audio'))
        except ProbeError as error:
            error.diagnostic = {**self.diagnostic, **(error.diagnostic or {})}
            raise
        self.diagnostic['page_identity'] = ('unknown' if actual is None else
                                             'anonymous' if actual == 0 else
                                             'different_account' if expected and actual != expected else 'confirmed')
        if actual == 0:
            raise ProbeError('На странице VK текущий аккаунт не авторизован. Поиск не выполнялся.', self.diagnostic)
        if expected and actual and actual != expected:
            raise ProbeError('VK распознал другой аккаунт. Поиск не выполнялся.', self.diagnostic)
        return actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=['vk.ru', 'vk.com'], default='vk.ru')
    parser.add_argument('--user-id', type=int)
    parser.add_argument('--query', default='Queen')
    parser.add_argument('--browser-agent', action='store_true', help='Запросить User-Agent вашего браузера перед Cookie')
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
        user_agent = browser_agent(getpass.getpass('User-Agent вашего Chrome (ввод скрыт): ')) if args.browser_agent else None
        secret = getpass.getpass('Cookie VK (ввод скрыт): ')
    probe = SessionProbe(args.host, secret, user_agent=user_agent)
    del secret
    detected_id = probe.check_account(args.user_id)
    user_id = args.user_id or detected_id
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
        if isinstance(error, ProbeError) and error.diagnostic:
            print('Диагностика (без секретов): ' + json.dumps(error.diagnostic, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Never print provider bodies, request objects, cookies or tracebacks.
        print('Проверка не завершена. Секреты и ответ VK не выводились.', file=sys.stderr)
        sys.exit(1)
