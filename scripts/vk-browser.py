"""Temporary private browser on a VPS. UI is reachable through SSH only."""
import argparse
import grp
import http.client
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

USER = 'wave-vk'
STATE = Path('/var/lib/wave-vk')
RUNTIME = Path('/run/wave-vk-browser')
MARKER = Path('/etc/wave-vk-browser.json')
UNIT = 'wave-vk-browser.service'
DESCRIPTION = 'WAVE VK private browser'
DISPLAY = ':97'
PAGE = 'http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale&path=websockify'


class SetupError(Exception):
    pass


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def private_file(path, uid):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        raise SetupError('Небезопасные права или тип файла: ' + str(path))


def identity():
    account = pwd.getpwnam(USER)
    if account.pw_uid == 0 or account.pw_dir != str(STATE) or account.pw_shell != '/usr/sbin/nologin':
        raise SetupError('Учётная запись wave-vk не соответствует ожидаемой; ничего не изменено.')
    return account


def managed_account():
    if MARKER.exists() or MARKER.is_symlink():
        private_file(MARKER, 0)
        marker = json.loads(MARKER.read_text())
        account = identity()
        if marker != {'user': USER, 'uid': account.pw_uid, 'version': 1}:
            raise SetupError('Существующая настройка браузера не совпадает. Остановлено.')
    else:
        try:
            pwd.getpwnam(USER)
        except KeyError:
            pass
        else:
            raise SetupError('Пользователь wave-vk уже существует без метки этой установки. Не изменён.')
        if STATE.exists() or STATE.is_symlink():
            raise SetupError('Каталог /var/lib/wave-vk уже существует. Не изменён.')
        try:
            grp.getgrnam(USER)
        except KeyError:
            pass
        else:
            raise SetupError('Группа wave-vk уже существует. Не изменена.')
        run(['useradd', '--system', '--user-group', '--create-home', '--home-dir', str(STATE),
             '--shell', '/usr/sbin/nologin', USER])
        account = identity()
        os.chmod(STATE, 0o700)
        fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump({'user': USER, 'uid': account.pw_uid, 'version': 1}, file)
    info = STATE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid or info.st_mode & 0o077:
        raise SetupError('Каталог браузера должен быть закрытым и принадлежать wave-vk.')
    return account


def check_unit():
    result = subprocess.run(['systemctl', 'show', UNIT, '--property=Description', '--property=LoadState'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if fields.get('LoadState') == 'not-found':
        return
    if result.returncode or fields.get('LoadState') != 'loaded':
        raise SetupError('Не удалось проверить службы systemd. Запуск остановлен.')
    if fields.get('Description') != DESCRIPTION:
        raise SetupError('Имя службы браузера уже занято другой службой. Не изменено.')


def dependencies():
    required = ['google-chrome', 'Xvfb', 'xauth', 'x11vnc', 'websockify', 'openbox', 'dbus-run-session']
    missing = [name for name in required if not shutil.which(name)]
    if missing:
        raise SetupError('Не установлены: ' + ', '.join(missing))
    if not Path('/usr/share/novnc/vnc.html').is_file():
        raise SetupError('Не найден интерфейс noVNC /usr/share/novnc/vnc.html.')


def unit_command(script):
    return ['systemd-run', '--unit=' + UNIT, '--description=' + DESCRIPTION, '--collect',
            '--uid=' + USER, '--gid=' + USER,
            '--property=WorkingDirectory=' + str(STATE),
            '--property=RuntimeDirectory=wave-vk-browser', '--property=RuntimeDirectoryMode=0700',
            '--property=PrivateTmp=yes', '--property=ProtectHome=yes',
            '--property=ProtectSystem=strict', '--property=ReadWritePaths=' + str(STATE),
            '--property=MemoryMax=1536M', '--property=TasksMax=512',
            '--property=RuntimeMaxSec=2h', '--property=TimeoutStopSec=15s',
            '--property=KillMode=control-group', '--property=UMask=0077',
            '/usr/bin/python3', str(script), '_worker']


def browser_commands(authority, profile, password):
    return [
        ('display', ['Xvfb', DISPLAY, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-auth', str(authority), '-noreset']),
        ('window manager', ['openbox']),
        ('VNC', ['x11vnc', '-display', DISPLAY, '-auth', str(authority), '-rfbauth', str(password),
                 '-localhost', '-no6', '-listen', '127.0.0.1', '-rfbport', '5900', '-forever', '-shared', '-noxdamage', '-quiet']),
        ('web UI', ['websockify', '--web=/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900']),
        ('Chrome', ['dbus-run-session', '--', 'google-chrome', '--user-data-dir=' + str(profile),
                    '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
                    '--start-maximized', 'https://vk.ru/audio']),
    ]


def ui_ready():
    connection = http.client.HTTPConnection('127.0.0.1', 6080, timeout=0.5)
    try:
        connection.request('GET', '/vnc.html')
        response = connection.getresponse()
        return response.status == 200 and b'noVNC' in response.read(65536)
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def collect_error(stream, hints, name):
    # Child logs may contain login URLs. Emit only a fixed classification.
    patterns = [('sandbox', ('no usable sandbox', 'failed to move to new namespace', 'failed to unshare')),
                ('display', ('cannot open display', 'missing x server', 'failed to connect to x11')),
                ('libraries', ('error while loading shared libraries',)),
                ('profile_lock', ('singletonlock', 'profile appears to be in use')),
                ('port_busy', ('address already in use',))]
    try:
        while True:
            chunk = stream.readline(4096)
            if not chunk:
                return
            lowered = chunk.decode('utf-8', 'replace').lower()
            for category, terms in patterns:
                if any(term in lowered for term in terms):
                    hints[name] = category
    finally:
        stream.close()


def worker():
    account = identity()
    if os.geteuid() != account.pw_uid:
        raise SetupError('Браузер должен запускаться отдельным пользователем wave-vk, не root.')
    os.umask(0o077)
    password = STATE / 'vnc.pass'
    private_file(password, account.pw_uid)
    profile = STATE / 'profile'
    profile.mkdir(mode=0o700, exist_ok=True)
    if profile.is_symlink() or not profile.is_dir():
        raise SetupError('Небезопасный путь профиля.')
    authority = RUNTIME / 'Xauthority'
    # X authentication goes through stdin, never process arguments or logs.
    run(['xauth', '-f', str(authority), 'source', '-'],
        input=f'add {DISPLAY} . {secrets.token_hex(16)}\n', text=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    env = {**os.environ, 'DISPLAY': DISPLAY, 'XAUTHORITY': str(authority)}
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    children = []
    hints = {}
    try:
        for name, command in browser_commands(authority, profile, password):
            children.append((name, subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
                                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)))
            threading.Thread(target=collect_error, args=(children[-1][1].stderr, hints, name), daemon=True).start()
            if name == 'display':
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if children[0][1].poll() is not None:
                        raise SetupError('Не запустился Xvfb.')
                    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    connection.settimeout(0.2)
                    try:
                        connection.connect('/tmp/.X11-unix/X97')
                        break
                    except OSError:
                        time.sleep(0.1)
                    finally:
                        connection.close()
                else:
                    raise SetupError('Истекло время ожидания Xvfb.')
        started = time.monotonic()
        ready = False
        while not stop.wait(0.25):
            for name, process in children:
                if process.poll() is not None:
                    raise SetupError('Завершился компонент: ' + name + '; exit=' + str(process.returncode)
                                     + '; причина=' + hints.get(name, 'unknown') + '. Песочница Chrome не отключалась.')
            if not ready and time.monotonic() - started > 2 and ui_ready():
                (RUNTIME / 'ready').write_text('ready\n')
                print('Браузер готов. Доступ только на 127.0.0.1:6080, пароль VNC включён.', flush=True)
                ready = True
            if not ready and time.monotonic() - started > 20:
                raise SetupError('Интерфейс браузера не готов за 20 секунд.')
    finally:
        (RUNTIME / 'ready').unlink(missing_ok=True)
        for _, process in reversed(children):
            if process.poll() is None:
                process.terminate()
        for _, process in reversed(children):
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()


def active():
    return subprocess.run(['systemctl', 'is-active', '--quiet', UNIT]).returncode == 0


def start(script):
    dependencies()
    check_unit()
    if active():
        print('Служба браузера уже запущена. Открыть на Mac: ' + PAGE)
        return
    # Do not take ports away from existing services.
    for port in (5900, 6080):
        with socket.socket() as connection:
            try:
                connection.bind(('127.0.0.1', port))
            except OSError:
                raise SetupError(f'Порт {port} занят. Существующий процесс не изменён.') from None
    account = managed_account()
    password = STATE / 'vnc.pass'
    if password.exists() or password.is_symlink():
        private_file(password, account.pw_uid)
    else:
        if not sys.stdin.isatty():
            raise SetupError('Нужен интерактивный терминал для создания пароля VNC.')
        print('Задайте отдельный пароль для окна браузера: 8 символов. Не используйте пароль VK.', flush=True)
        run(['runuser', '-u', USER, '--', 'x11vnc', '-storepasswd', str(password)])
        private_file(password, account.pw_uid)
    run(unit_command(script))
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if active() and (RUNTIME / 'ready').is_file() and ui_ready():
            print('Готово. В Chrome на Mac откройте:\n' + PAGE)
            print('Пароль окна браузера — тот, который вы задали. Автоостановка через 2 часа.')
            print('Остановить: python3 ' + str(script) + ' stop')
            return
        if not active():
            break
        time.sleep(0.5)
    subprocess.run(['journalctl', '-u', UNIT, '-n', '12', '--no-pager', '-o', 'cat'])
    subprocess.run(['systemctl', 'stop', UNIT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    raise SetupError('Браузер не запустился. Другие службы не менялись. Песочница Chrome не отключалась.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', '_worker'])
    args = parser.parse_args()
    if args.action == '_worker':
        worker()
        return
    if os.geteuid() != 0:
        raise SetupError('Запустите на VPS от root.')
    check_unit()
    if args.action == 'start':
        start(Path(__file__).resolve())
    elif args.action == 'stop':
        run(['systemctl', 'stop', UNIT])
        print('Окно браузера закрыто. Профиль с входом сохранён в закрытом /var/lib/wave-vk/profile.')
    else:
        print('Браузер: ' + ('запущен' if active() else 'остановлен'))


if __name__ == '__main__':
    try:
        main()
    except (SetupError, OSError, KeyError, ValueError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, SetupError) else 'Не удалось запустить браузер. Секреты не выводились.', file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('Операция остановлена. Если браузер уже запущен, используйте команду stop.', file=sys.stderr)
        sys.exit(1)
