"""Inspect the latest requested cached audio locally; never print credentials."""
import base64
import hashlib
import json
import re
import shutil
import subprocess
from collections import deque
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def main():
    repo = Path(__file__).resolve().parent.parent
    revision = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--short', 'HEAD'],
                              capture_output=True, text=True, check=True).stdout.strip()
    print('Версия WAVE:', revision)
    with open('/var/log/nginx/access.log') as file:
        lines = deque(file, maxlen=2000)
    paths = [match.group(1) for line in lines
             if (match := re.search(r'GET (/api/stream\?[^ ]+) HTTP/', line))]
    if not paths:
        raise SystemExit('Нажмите на проблемный трек и повторите команду.')
    ticket = parse_qs(urlsplit(paths[-1]).query).get('ticket', [''])[0]
    payload = ticket.split('.')[0]
    data = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    file_id = data.get('file')
    if not isinstance(file_id, str) or len(file_id) > 4000:
        raise SystemExit('Не удалось определить файл. Повторите запрос трека.')
    config = {}
    for line in Path('/etc/wave.env').read_text().splitlines():
        name, sep, value = line.partition('=')
        if sep and name in ('BOT_TOKEN', 'WAVE_CACHE_DIR'):
            config[name] = value.strip().strip('"\'')
    if not config.get('BOT_TOKEN'):
        raise SystemExit('Токен отсутствует в конфигурации. Значения не выводились.')
    digest = hashlib.sha256((config['BOT_TOKEN'] + ':' + file_id).encode()).hexdigest()
    directory = Path(config.get('WAVE_CACHE_DIR') or '/var/lib/wave/wave-audio-cache')
    audio = directory / (digest + '.bin')
    if not audio.is_file():
        raise SystemExit('Готового файла в постоянном кэше нет. Дождитесь загрузки и повторите.')
    meta = json.loads((directory / (digest + '.json')).read_text())
    print('Исходный тип в кэше (не HTTP-заголовок):', meta.get('mime', 'не указан'))
    print('Размер файла:', audio.stat().st_size, 'байт')
    print('Размер совпадает с кэшем:', audio.stat().st_size == meta.get('size'))
    with audio.open('rb') as file:
        prefix = file.read(4096)
    kind = 'не определён'
    if prefix.startswith(b'ID3') or (len(prefix) > 1 and prefix[0] == 255 and prefix[1] & 0xE0 == 0xE0):
        kind = 'MPEG/MP3 или AAC (уточнит ffprobe)'
    if prefix[4:8] == b'ftyp':
        kind = 'MP4/M4A'
    if prefix.startswith(b'OggS'):
        kind = 'Ogg/Opus' if b'OpusHead' in prefix else 'Ogg'
    if prefix.startswith(b'fLaC'):
        kind = 'FLAC'
    if prefix.startswith(b'RIFF') and prefix[8:12] == b'WAVE':
        kind = 'WAV'
    print('Контейнер по началу файла:', kind)
    probe = shutil.which('ffprobe')
    if not probe:
        print('Для проверки кодека нужен ffprobe из пакета ffmpeg.')
        return
    result = subprocess.run([probe, '-v', 'error', '-select_streams', 'a:0',
                             '-show_entries', 'stream=codec_name,codec_long_name,sample_rate,channels:format=format_name,duration,size',
                             '-of', 'json', str(audio)], capture_output=True, text=True, timeout=30)
    print('Код завершения ffprobe:', result.returncode)
    packet = subprocess.run([probe, '-v', 'error', '-select_streams', 'a:0',
                             '-read_intervals', '%+#1', '-show_packets',
                             '-show_entries', 'packet=pos', '-of', 'json', str(audio)],
                            capture_output=True, text=True, timeout=30)
    try:
        position=json.loads(packet.stdout).get('packets',[{}])[0].get('pos')
        if position is not None:print('Позиция первого аудиопакета:',int(position),'байт')
    except (ValueError,IndexError,TypeError):pass
    try:
        info = json.loads(result.stdout)
        # Output only named codec/container properties, never tags, paths or URLs.
        safe = {'streams': [{k: v for k, v in item.items() if k in
                            ('codec_name', 'codec_long_name', 'sample_rate', 'channels')}
                           for item in info.get('streams', [])],
                'format': {k: v for k, v in info.get('format', {}).items()
                           if k in ('format_name', 'duration', 'size')}}
        print(json.dumps(safe, ensure_ascii=False, indent=2))
    except ValueError:
        print('Формат файла не удалось распознать.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit('Диагностика не завершена. Проверьте запуск от root; секреты не выводились.')
