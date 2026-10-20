"""Offline regressions: no HTTP server, browser, or external downloads."""
import io
import ipaddress
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remote_vps_server as srv


VIDEO_ID = "dQw4w9WgXcQ"
EXTENSION_ORIGIN = "chrome-extension://" + "a" * 32
METADATA = {
    "title": "Test video", "uploader": "Test channel",
    "formats": [
        {"url": "https://media.example.invalid/audio", "vcodec": "none", "acodec": "mp4a.40.2"},
        {"url": "https://media.example.invalid/video", "height": 2160, "vcodec": "vp9", "acodec": "none"},
    ],
}


class EngineSecurityTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in (
            ("COOKIE_DIR", directory.name), ("TICKETS", {}), ("STREAMS", {}), ("RATE", {}),
            ("TRUSTED_PROXY_NETS", [ipaddress.ip_network("172.16.0.0/12"), ipaddress.ip_network("127.0.0.1/32")]),
        ):
            replacement = patch.object(srv, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)

    def handler(self, path="/prepare", body=None, origin=None, peer="172.20.0.5"):
        handler = object.__new__(srv.RemoteHandler)
        handler.path = path
        handler.client_address = (peer, 12345)
        data = json.dumps(body or {}).encode()
        handler.headers = {"Content-Length": str(len(data)), "Content-Type": "application/json"}
        if origin is not None:
            handler.headers["Origin"] = origin
        handler.rfile = io.BytesIO(data)
        handler.wfile = io.BytesIO()
        for method in ("send_response", "send_header", "end_headers", "_json"):
            setattr(handler, method, Mock())
        return handler

    def test_extension_prepare_and_stream_keep_existing_contract(self):
        for origin in (None, EXTENSION_ORIGIN):
            for quality in ("4k", "2160p", "1440p", "1080p", "720p", "360p", "mp3"):
                with self.subTest(origin=origin, quality=quality):
                    handler = self.handler(body={"url": VIDEO_ID, "format": quality}, origin=origin)
                    with patch.object(srv, "_run_dump_json", return_value=subprocess.CompletedProcess([], 0, json.dumps(METADATA), "")):
                        handler.do_POST()
                    status, prepared = handler._json.call_args.args
                    self.assertEqual(status, 200)
                    self.assertTrue(prepared["success"])
                    self.assertEqual(prepared["ext"], "mp3" if quality == "mp3" else "mp4")
                    stream = self.handler("/stream?ticket=" + prepared["ticket"], origin=origin)
                    proc = Mock(stdout=io.BytesIO(b"test-media"))
                    proc.poll.return_value = 0
                    with patch.object(srv.subprocess, "Popen", return_value=proc):
                        stream.do_GET()
                    stream.send_response.assert_called_once_with(200)
                    self.assertEqual(stream.wfile.getvalue(), b"test-media")
                    self.assertEqual(srv.STREAMS, {})
                    self.assertNotIn(prepared["ticket"], srv.TICKETS)
                    stream.do_GET()
                    self.assertEqual(stream._json.call_args.args[0], 403)
                    srv.RATE.clear()

    def test_extension_status_and_info_still_work(self):
        for path in ("/status", "/info?url=" + VIDEO_ID):
            handler = self.handler(path, origin=EXTENSION_ORIGIN)
            with patch.object(srv, "fetch_metadata", return_value=METADATA):
                handler.do_GET()
            self.assertEqual(handler._json.call_args.args[0], 200)

    def test_web_origins_are_rejected_before_api_work(self):
        with patch.object(srv, "fetch_metadata") as fetch:
            for method in ("do_GET", "do_POST", "do_OPTIONS"):
                handler = self.handler(origin="https://example.invalid")
                getattr(handler, method)()
                self.assertEqual(handler._json.call_args.args[0], 403)
            fetch.assert_not_called()

    def test_cookie_proxy_compatibility_and_cleanup(self):
        for fail in (False, True):
            def lookup(video_id, cookie_file):
                self.assertEqual(os.stat(cookie_file).st_mode & 0o777, 0o600)
                if fail:
                    raise srv.UserError("Lookup failed", 502)
                return METADATA

            handler = self.handler(body={
                "url": VIDEO_ID, "format": "mp3",
                "cookies": [{"domain": ".youtube.com", "name": "SID", "value": "test-session"}],
            }, origin=EXTENSION_ORIGIN)
            with patch.object(srv, "fetch_metadata", side_effect=lookup):
                handler.do_POST()
            self.assertEqual(handler._json.call_args.args[0], 502 if fail else 200)
            self.assertEqual(os.listdir(srv.COOKIE_DIR), [])

    def test_metadata_capacity_recovers_after_success_and_failure(self):
        slots = threading.BoundedSemaphore(1)
        with patch.object(srv, "METADATA_SLOTS", slots), patch.object(srv, "_fetch_metadata", return_value=METADATA) as lookup:
            slots.acquire()
            with self.assertRaises(srv.UserError) as busy:
                srv.fetch_metadata(VIDEO_ID)
            self.assertEqual(busy.exception.status, 503)
            lookup.assert_not_called()
            slots.release()
            self.assertEqual(srv.fetch_metadata(VIDEO_ID), METADATA)
            lookup.side_effect = srv.UserError("Lookup failed", 502)
            with self.assertRaises(srv.UserError):
                srv.fetch_metadata(VIDEO_ID)
            self.assertTrue(slots.acquire(blocking=False))
            slots.release()

    def test_raw_metadata_errors_are_not_logged(self):
        result = subprocess.CompletedProcess([], 1, "", "ERROR: sensitive-test-cookie")
        with patch.object(srv.subprocess, "run", return_value=result), patch.object(srv, "log") as log:
            with self.assertRaises(srv.UserError) as error:
                srv.fetch_metadata(VIDEO_ID)
            self.assertNotIn("sensitive-test-cookie", str(log.call_args_list))
            self.assertNotIn("sensitive-test-cookie", error.exception.message)

    def test_watchdog_terminates_stalled_stream_and_releases_slot(self):
        handler = self.handler()
        srv.TICKETS["test-ticket"] = {
            "spec": {"type": "progressive", "url": "https://media.example.invalid/video"},
            "title": "Test", "ext": "mp4", "expires": time.time() + 60,
        }
        # A real pipe without output reproduces the blocked read without network I/O.
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"], stdout=subprocess.PIPE)
        started = time.monotonic()
        try:
            with patch.object(srv.subprocess, "Popen", return_value=proc), patch.object(srv, "STREAM_MAX_SECONDS", 0.1):
                handler._handle_stream({"ticket": ["test-ticket"]})
            self.assertLess(time.monotonic() - started, 3)
            self.assertIsNotNone(proc.poll())
            self.assertEqual(srv.STREAMS, {})
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=2)
            proc.stdout.close()


def tearDownModule():
    shutil.rmtree(srv.COOKIE_DIR, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
