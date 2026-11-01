"""Measure the latest WAVE audio request locally without printing private URLs."""
import re
import time
import urllib.error
import urllib.request
from collections import deque

try:
    with open('/var/log/nginx/access.log') as file:
        lines = deque(file, maxlen=2000)
except OSError:
    raise SystemExit('Не удалось прочитать журнал Nginx. Запустите на VPS от root.')

paths = [match.group(1) for line in lines
         if (match := re.search(r'GET (/api/stream\?[^ ]+) HTTP/', line))]
if not paths:
    raise SystemExit('Нажмите на трек в Mini App и повторите проверку.')

for attempt in range(1, 3):
    request = urllib.request.Request('http://127.0.0.1:8787' + paths[-1],
                                     headers={'Range': 'bytes=0-65535'})
    start = time.monotonic()
    try:
        response = urllib.request.urlopen(request, timeout=50)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, TimeoutError):
        raise SystemExit('Backend недоступен или не ответил за 50 секунд.')
    with response:
        headers_ms = (time.monotonic()-start)*1000
        if response.status not in (200, 206):
            raise SystemExit(f'HTTP {response.status}. Заново откройте Mini App, включите трек и повторите проверку.')
        chunk = response.read(65536)
        print(f'Запрос {attempt}: HTTP {response.status}; заголовки за {headers_ms:.0f} мс; '
              f'{len(chunk)} байт за {(time.monotonic()-start)*1000:.0f} мс')
        print('Этапы backend:', response.headers.get('Server-Timing', 'нет данных — обновите WAVE'))
