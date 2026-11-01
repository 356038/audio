"""Store Audius app credentials on the VPS without exposing them in history."""
import getpass
import json
import os
import stat
import tempfile
import time
from pathlib import Path


def main():
    if os.geteuid() != 0:
        raise SystemExit('Запустите от root на VPS WAVE.')
    path = Path('/etc/wave.env')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
        raise SystemExit('Нужен обычный root-owned файл /etc/wave.env. Ничего не изменено.')
    original = path.read_bytes()
    values = {}
    for name, label in [('AUDIUS_API_KEY', 'API Key'), ('AUDIUS_BEARER_TOKEN', 'Bearer Token')]:
        value = getpass.getpass(label + ' Audius (ввод скрыт): ').strip()
        if not value or len(value) > 8192 or any(c.isspace() or not c.isascii() or not c.isprintable() for c in value):
            raise SystemExit('Неверный формат ключа. Ничего не изменено.')
        values[name] = value
    lines = [line for line in original.decode().splitlines()
             if line.partition('=')[0].strip() not in values]
    lines.extend(name + '=' + json.dumps(value) for name, value in values.items())
    backup = Path('/etc/wave.env.before-audius-' + str(time.time_ns()))
    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
        file.write(original)
    fd, temporary = tempfile.mkstemp(dir='/etc', prefix='.wave-audius-')
    try:
        with os.fdopen(fd, 'w') as file:
            file.write('\n'.join(lines) + '\n')
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Ключи Audius сохранены в /etc/wave.env. Другие настройки сохранены.')
    print('Приватная резервная копия:', backup)


if __name__ == '__main__':
    try:
        main()
    except OSError:
        raise SystemExit('Не удалось сохранить настройки. Значения ключей не выводились.')
