"""Local WAVE playback experiment. No bot token or external dependencies."""
import io
import math
import struct
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


def melody(index):
    output = io.BytesIO()
    rate = 22050
    notes = ([261.63, 329.63, 392, 523.25], [293.66, 349.23, 440, 587.33])[index]
    with wave.open(output, 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        samples = bytearray()
        for frame in range(rate * 12):
            t = frame / rate
            phase = t % .5
            envelope = min(1, phase / .02) * max(0, 1 - phase / .5)
            value = int(6500 * envelope * math.sin(2 * math.pi * notes[int(t * 2) % 4] * t))
            samples.extend(struct.pack('<h', value))
        audio.writeframes(samples)
    return output.getvalue()


TRACKS = {f'/audio/{i}.wav': melody(i) for i in range(2)}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/', '/index.html'):
            content = Path(__file__).with_name('index.html').read_bytes()
            kind = 'text/html; charset=utf-8'
        elif path in TRACKS:
            content = TRACKS[path]
            kind = 'audio/wav'
        else:
            self.send_error(404)
            return
        start, end = 0, len(content) - 1
        partial = self.headers.get('Range')
        if partial and kind == 'audio/wav':
            try:
                unit, bounds = partial.split('=', 1)
                first, last = bounds.split('-', 1)
                if unit != 'bytes' or ',' in bounds:
                    raise ValueError()
                if first:
                    start = int(first)
                    end = min(int(last), end) if last else end
                else:
                    start = max(0, len(content) - int(last))
                if start < 0 or start > end or start >= len(content):
                    raise ValueError()
            except ValueError:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{len(content)}')
                self.end_headers()
                return
        self.send_response(206 if partial and kind == 'audio/wav' else 200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        if partial and kind == 'audio/wav':
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(content)}')
        self.end_headers()
        self.wfile.write(content[start:end + 1])


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
