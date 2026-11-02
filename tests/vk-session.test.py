"""Security and protocol checks with synthetic responses; no VK login."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error

spec = importlib.util.spec_from_file_location('vk_session', Path(__file__).resolve().parents[1] / 'scripts/check-vk-session.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Checks(unittest.TestCase):
    def test_cookie_rejects_header_injection_and_accepts_copied_header(self):
        self.assertEqual(probe.cookie_header('Cookie: a=b; c=d'), 'a=b; c=d')
        for value in ['', 'a=b\r\nHost: other', 'a=b\nCookie: c=d', 'curl https://vk.ru', 'a=ю']:
            with self.assertRaises(probe.ProbeError):
                probe.cookie_header(value)

    def test_identity_only_comes_from_current_user_object(self):
        self.assertEqual(probe.account_id('window.vk = {id: 123, lang: 0};'), 123)
        self.assertEqual(probe.account_id('var vk = {"id":456};'), 456)
        self.assertEqual(probe.account_id('vk.id = 789;'), 789)
        self.assertIsNone(probe.account_id('{"playlist":{"owner_id":999},"id":888}'))
        self.assertEqual(probe.account_id('var vk = {id:0, lang:0};'), 0)

    def test_failed_response_diagnostics_never_include_provider_strings(self):
        value = {'payload':[3, ['https://login.example/?cookie=PRIVATE', {'redirect':'PRIVATE', 'remixsid':'PRIVATE'}]], 'secret':'PRIVATE'}
        with self.assertRaises(probe.ProbeError) as error:
            probe.search_rows(json.dumps(value))
        diagnostic = error.exception.diagnostic
        self.assertEqual(diagnostic['payload_code'], 3)
        self.assertEqual(diagnostic['reply_types'], ['string', 'object'])
        self.assertNotIn('PRIVATE', json.dumps(diagnostic))
        self.assertNotIn('login.example', json.dumps(diagnostic))
        self.assertNotIn('redirect', json.dumps(diagnostic))
        for code in ['PRIVATE', 9999999999999, True, {'cookie':'PRIVATE'}]:
            self.assertEqual(probe.response_shape({'payload':[code]})['payload_code'], 'unknown')

    def test_account_check_distinguishes_anonymous_mismatch_and_unrecognized_page(self):
        for page, expected, state, failure in [('vk.id = 0;', 123, 'anonymous', True),
                                                ('vk.id = 456;', 123, 'different_account', True),
                                                ('vk.id = 123;', 123, 'confirmed', False),
                                                ('<html>unknown page</html>', 123, 'unknown', False)]:
            calls = []
            class Response:
                status=200
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, count): return page.encode()
            class Opener:
                def open(self, request, timeout):
                    calls.append(request)
                    return Response()
            session = probe.SessionProbe('vk.ru', 'remixsid=PRIVATE; other=PRIVATE', Opener())
            if failure:
                with self.assertRaises(probe.ProbeError):
                    session.check_account(expected)
            else:
                session.check_account(expected)
            self.assertEqual(session.diagnostic['page_identity'], state)
            self.assertEqual(session.diagnostic['cookie_presence']['remixsid'], True)
            self.assertNotIn('PRIVATE', json.dumps(session.diagnostic))
            self.assertEqual([r.full_url for r in calls], ['https://vk.ru/audios123'])

    def test_search_does_not_print_urls_or_hashes_and_rejects_challenges(self):
        row = [1, 2, 'https://secret.example/signed', '<b>Song</b>\x1b[31m', 'Artist', 60, 'private hash']
        body = '<!--' + json.dumps({'payload':[0, [0, {'playlist':{'list':[row]}}]]})
        tracks = probe.search_rows(body)
        self.assertEqual(tracks[0]['artist'], 'Artist')
        self.assertNotIn('secret', str(tracks))
        self.assertNotIn('\x1b', str(tracks))
        self.assertEqual(probe.search_rows(json.dumps({'payload':[0, [0, {'playlist':None}]]})), [])
        for value in ['<html>login</html>', '{"payload":[8,"private challenge"]}', '{"error":"private body"}']:
            with self.assertRaises(probe.ProbeError) as error:
                probe.search_rows(value)
            self.assertNotIn('private', str(error.exception))

    def test_redirects_do_not_forward_cookies_and_errors_do_not_echo_them(self):
        calls = []
        class Opener:
            def open(self, request, timeout):
                calls.append(request)
                raise urllib.error.HTTPError(request.full_url, 302, 'secret', {'Location':'https://other.example/'}, io.BytesIO(b'secret'))
        session = probe.SessionProbe('vk.ru', 'session=private', Opener())
        with self.assertRaises(probe.ProbeError) as error:
            session.request('/audio')
        self.assertEqual(len(calls), 1)
        self.assertNotIn('private', str(error.exception))
        self.assertIsNone(probe.NoRedirect().redirect_request(calls[0], None, 302, '', {}, 'https://other.example'))
        with self.assertRaises(probe.ProbeError):
            session.request('https://other.example')
        with self.assertRaises(probe.ProbeError):
            probe.SessionProbe('vk.ru.other.example', 'a=b')

    def test_body_bound_and_read_only_search_request(self):
        calls=[]
        class Response:
            status=200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, count): return b'x' * count
        class Opener:
            def open(self, request, timeout):
                calls.append(request)
                return Response()
        session = probe.SessionProbe('vk.ru', 'session=private', Opener())
        with self.assertRaises(probe.ProbeError):
            session.search('Queen', 123)
        request=calls[0]
        self.assertEqual(request.full_url, 'https://vk.ru/al_audio.php')
        self.assertIn(b'section=search', request.data)
        self.assertNotIn(b'session=private', request.data)


if __name__ == '__main__':
    unittest.main()
