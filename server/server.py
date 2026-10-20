#!/usr/bin/env python3
"""
YouTube Downloader - Native Companion Server
Direct local video & audio downloader using yt-dlp and ffmpeg.
Saves lossless 4K / 1080p / MP3 directly to ~/Downloads.
"""

import os
import re
import sys
import json
import uuid
import shutil
import tempfile
import platform
import threading
import subprocess
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Ensure common tool locations (deno, ffmpeg, homebrew) are in PATH
EXTRA_PATHS = [
    str(Path.home() / ".deno" / "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
]
os.environ["PATH"] = ":".join(EXTRA_PATHS) + ":" + os.environ.get("PATH", "")

PORT = 8989
# Loopback only: other devices on the network must not be able to reach this.
BIND = "127.0.0.1"
DOWNLOAD_DIR = str(Path.home() / "Downloads")

MAX_BODY_BYTES = 256 * 1024
MAX_JOBS = 200
MAX_ACTIVE_JOBS = 3

# Host header allowlist (defends against DNS rebinding)
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}", f"[::1]:{PORT}"}

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com",
}
SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
ALLOWED_QUALITIES = {"mp3", "4k", "2160p", "1440p", "2k", "1080p", "720p", "360p", "best"}

JOBS = {}
JOBS_LOCK = threading.Lock()


def extract_video_id(raw):
    """Return the 11-char video ID from a YouTube URL, else None."""
    if not raw or not isinstance(raw, str) or len(raw) > 2048:
        return None
    try:
        parsed = urlparse(raw.strip())
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    candidate = None
    if host in SHORT_HOSTS:
        candidate = parsed.path.lstrip("/").split("/")[0]
    elif host in YOUTUBE_HOSTS:
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [None])[0]
        else:
            parts = parsed.path.strip("/").split("/")
            if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v"):
                candidate = parts[1]
    if candidate and VIDEO_ID_RE.match(candidate):
        return candidate
    return None


def prune_jobs():
    """Drop the oldest finished jobs so JOBS can't grow without bound. Caller holds JOBS_LOCK."""
    if len(JOBS) < MAX_JOBS:
        return
    finished = [k for k, v in JOBS.items() if v["status"] in ("complete", "error")]
    for k in finished[: len(JOBS) - MAX_JOBS + 1]:
        del JOBS[k]

def get_ytdlp_path():
    local_venv = os.path.join(os.path.dirname(__file__), "venv", "bin", "yt-dlp")
    if os.path.exists(local_venv) and os.access(local_venv, os.X_OK):
        return local_venv
    system_ytdlp = shutil.which("yt-dlp")
    if system_ytdlp:
        return system_ytdlp
    return None

def has_ffmpeg():
    return shutil.which("ffmpeg") is not None

def open_folder(path):
    if platform.system() == "Darwin":
        subprocess.run(["open", path])
    elif platform.system() == "Windows":
        os.startfile(path)
    else:
        subprocess.run(["xdg-open", path])

def clean_cookie_field(value):
    # Tabs/newlines would let a value inject extra lines into the cookie file.
    return re.sub(r"[\t\r\n]", "", str(value or ""))[:4096]

def write_netscape_cookies(cookies_list):
    if not cookies_list:
        return None
    try:
        tf = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt")
        tf.write("# Netscape HTTP Cookie File\n")
        for c in cookies_list[:200]:
            if not isinstance(c, dict):
                continue
            domain = clean_cookie_field(c.get("domain", ".youtube.com"))
            # Only YouTube cookies; never let a caller plant cookies for other sites.
            if domain.lstrip(".") not in YOUTUBE_HOSTS:
                continue
            flag = "TRUE" if domain.startswith(".") else "FALSE"
            path = clean_cookie_field(c.get("path", "/")) or "/"
            secure = "TRUE" if c.get("secure", False) else "FALSE"
            try:
                exp = str(int(c.get("expirationDate") or 2147483647))
            except (TypeError, ValueError):
                exp = "2147483647"
            name = clean_cookie_field(c.get("name", ""))
            val = clean_cookie_field(c.get("value", ""))
            if name and val:
                tf.write(f"{domain}\t{flag}\t{path}\t{secure}\t{exp}\t{name}\t{val}\n")
        tf.flush()
        return tf.name
    except Exception as e:
        print("Failed to write cookies file:", e)
        return None

def download_worker(task_id, url, quality, custom_title=None, cookies_list=None):
    output_template = os.path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s")
    cookie_path = write_netscape_cookies(cookies_list)

    with JOBS_LOCK:
        JOBS[task_id]["status"] = "starting"
        JOBS[task_id]["percent"] = 5

    # Fail-safe format selectors with fallback chain
    if quality == "mp3":
        fmt = "bestaudio/best"
    elif quality in ("4k", "2160p"):
        fmt = "bestvideo[height<=?2160]+bestaudio/best[height<=?2160]/bestvideo+bestaudio/best"
    elif quality in ("1440p", "2k"):
        fmt = "bestvideo[height<=?1440]+bestaudio/best[height<=?1440]/bestvideo+bestaudio/best"
    elif quality == "1080p":
        fmt = "bestvideo[height<=?1080]+bestaudio/best[height<=?1080]/bestvideo+bestaudio/best"
    elif quality == "720p":
        fmt = "bestvideo[height<=?720]+bestaudio/best[height<=?720]/bestvideo+bestaudio/best"
    elif quality == "360p":
        fmt = "best[height<=?360]/best/worst"
    else:
        fmt = "bestvideo+bestaudio/best"

    try:
        import yt_dlp

        class ProgressHook:
            def __call__(self, d):
                with JOBS_LOCK:
                    if d.get("status") == "downloading":
                        total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                        downloaded = d.get("downloaded_bytes") or 0
                        pct = round((downloaded / total) * 100, 1) if total > 0 else 50.0
                        JOBS[task_id]["status"] = "downloading"
                        JOBS[task_id]["percent"] = min(pct, 99.0)
                        JOBS[task_id]["speed"] = d.get("_speed_str", "").strip()
                        JOBS[task_id]["eta"] = d.get("_eta_str", "").strip()
                    elif d.get("status") == "finished":
                        JOBS[task_id]["status"] = "merging"
                        JOBS[task_id]["percent"] = 99.0
                        JOBS[task_id]["filename"] = os.path.basename(d.get("filename", ""))

        ydl_opts = {
            "format": fmt,
            "outtmpl": output_template,
            "quiet": False,
            "noplaylist": True,
            "remote_components": ["ejs:github"],
            "extractor_args": {
                "youtube": {
                    "player_client": ["android", "ios", "tv"]
                }
            },
            "progress_hooks": [ProgressHook()]
        }

        if cookie_path:
            ydl_opts["cookiefile"] = cookie_path

        if quality == "mp3":
            ydl_opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "320"
            }]
        else:
            ydl_opts["merge_output_format"] = "mp4"

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", custom_title or "Video")
            ext = "mp3" if quality == "mp3" else "mp4"

        with JOBS_LOCK:
            JOBS[task_id]["status"] = "complete"
            JOBS[task_id]["percent"] = 100.0
            JOBS[task_id]["title"] = title
            JOBS[task_id]["filename"] = f"{title}.{ext}"

    except Exception as e:
        err_msg = str(e)
        # Clean up long traceback prefixes
        if "ERROR:" in err_msg:
            err_msg = err_msg.split("ERROR:", 1)[1].strip()
        print(f"[Task {task_id} Error]: {err_msg}")
        with JOBS_LOCK:
            JOBS[task_id]["status"] = "error"
            JOBS[task_id]["error"] = err_msg
    finally:
        if cookie_path and os.path.exists(cookie_path):
            try:
                os.remove(cookie_path)
            except Exception:
                pass


class CompanionHandler(BaseHTTPRequestHandler):
    def _cors(self):
        # Only the Chrome extension may call this API from a browser.
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _host_ok(self):
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    def _origin_ok(self):
        # Browsers always attach Origin to cross-origin requests and web pages
        # cannot forge it, so this blocks drive-by requests from websites.
        # Requests without an Origin come from local tools (curl, scripts).
        origin = self.headers.get("Origin")
        return origin is None or origin.startswith("chrome-extension://")

    def _reject(self, status, message):
        body = json.dumps({"success": False, "error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self._host_ok() or not self._origin_ok():
            self._reject(403, "Forbidden")
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not self._host_ok() or not self._origin_ok():
            self._reject(403, "Forbidden")
            return
        parsed = urlparse(self.path)

        if parsed.path == "/status":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            data = {
                "status": "online",
                "ytdlp": get_ytdlp_path() is not None,
                "ffmpeg": has_ffmpeg(),
                "download_dir": DOWNLOAD_DIR
            }
            self.wfile.write(json.dumps(data).encode("utf-8"))

        elif parsed.path == "/progress":
            qs = parse_qs(parsed.query)
            task_id = qs.get("task_id", [None])[0]
            with JOBS_LOCK:
                job = JOBS.get(task_id, {"status": "not_found", "percent": 0})

            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(job).encode("utf-8"))

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if not self._host_ok() or not self._origin_ok():
            self._reject(403, "Forbidden")
            return
        parsed = urlparse(self.path)

        if parsed.path == "/download":
            try:
                length = int(self.headers.get("Content-Length", 0))
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                self._reject(413 if length > 0 else 400, "Request body missing or too large")
                return
            body = self.rfile.read(length)
            try:
                data = json.loads(body.decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("Invalid JSON body")
                video_id = extract_video_id(data.get("url"))
                quality = data.get("format", "1080p")
                title = str(data.get("title", ""))[:300]
                cookies = data.get("cookies", [])
                if not isinstance(cookies, list):
                    cookies = []

                if not video_id:
                    raise ValueError("A valid YouTube video URL is required")
                if quality not in ALLOWED_QUALITIES:
                    raise ValueError("Unsupported format")
                url = f"https://www.youtube.com/watch?v={video_id}"

                task_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    active = sum(1 for j in JOBS.values() if j["status"] not in ("complete", "error"))
                    if active >= MAX_ACTIVE_JOBS:
                        raise ValueError("Too many downloads in progress. Please wait for one to finish.")
                    prune_jobs()
                    JOBS[task_id] = {
                        "task_id": task_id,
                        "status": "queued",
                        "percent": 0,
                        "speed": "",
                        "eta": "",
                        "title": title,
                        "filename": "",
                        "error": None
                    }

                t = threading.Thread(
                    target=download_worker,
                    args=(task_id, url, quality, title, cookies),
                    daemon=True
                )
                t.start()

                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "task_id": task_id}).encode("utf-8"))

            except Exception as e:
                self.send_response(400)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))

        elif parsed.path == "/open-folder":
            open_folder(DOWNLOAD_DIR)
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode("utf-8"))

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


def main():
    server_address = (BIND, PORT)
    httpd = HTTPServer(server_address, CompanionHandler)
    ytdlp_ok = "✅" if get_ytdlp_path() else "❌"
    ffmpeg_ok = "✅" if has_ffmpeg() else "❌"

    print("=" * 60)
    print(" 🚀 YouTube Downloader - Native Companion Engine")
    print("=" * 60)
    print(f" • Server Port:      http://localhost:{PORT}")
    print(f" • yt-dlp:          {ytdlp_ok}")
    print(f" • ffmpeg:          {ffmpeg_ok}")
    print(f" • Save Directory:  {DOWNLOAD_DIR}")
    print("=" * 60)
    print(" Ready! You can now download directly from Chrome.")
    print(" Press Ctrl+C to stop.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping companion engine.")
        httpd.server_close()

if __name__ == "__main__":
    main()
