#!/usr/bin/env python3
"""
YouTube Downloader - Remote VPS Engine (Multi-threaded)
Provides:
  - /status   : Health check
  - /info     : Video metadata (title, author, thumbnail, max height)
  - /prepare  : Validates a video and issues a short-lived, single-use ticket
  - /stream   : Live on-the-fly ffmpeg remux of a ticket to the client (zero disk usage)

Security model:
  - Only YouTube video URLs are accepted. Every URL is reduced to its 11-char
    video ID and rebuilt, so nothing user-controlled reaches yt-dlp's argv
    except a canonical https://www.youtube.com/watch?v=<id> after "--".
  - Formats come from a fixed allowlist.
  - Per-IP rate limits and concurrent stream limits stop the server being used
    as a free bulk proxy.
  - yt-dlp's raw error output is logged server-side, never returned to clients.
  - ffmpeg only reads https stream URLs produced by yt-dlp's YouTube extractor,
    and is restricted to network protocols (no file:, concat:, etc.).
  - Optional user cookies (opt-in in the extension) are only accepted over
    HTTPS via the Caddy reverse proxy, filtered to a small allowlist of
    YouTube cookie names, written to a private 0600 file, used for the
    metadata lookup only, and deleted immediately afterwards. They are never
    logged, stored in tickets, or kept in memory past the request.
"""

import os
import re
import sys
import json
import time
import shutil
import secrets
import tempfile
import ipaddress
import threading
import subprocess
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("YTDL_PORT", "8989"))
BIND = os.environ.get("YTDL_BIND", "0.0.0.0")
YTDLP_BIN = os.environ.get("YTDLP_BIN", "/opt/yt-downloader/venv/bin/yt-dlp")

MAX_BODY_BYTES = 16 * 1024
TICKET_TTL_SECONDS = 10 * 60
MAX_TICKETS = 5000
METADATA_TIMEOUT_SECONDS = 90
STREAM_MAX_SECONDS = 3 * 60 * 60

# Rate limiting (per client IP)
REQUESTS_PER_MINUTE = 30
MAX_STREAMS_PER_IP = 2
MAX_STREAMS_GLOBAL = 12

FALLBACK_EXTRACTOR_ARGS = "youtube:player_client=android,ios,tv,web"
FFMPEG_PROTOCOLS = "https,tls,tcp,http,hls,crypto"

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com",
}
SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# quality -> max height (None = audio)
QUALITY_HEIGHTS = {
    "4k": 2160, "2160p": 2160,
    "2k": 1440, "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "360p": 360,
    "mp3": None,
}

# Requests from these networks are our own reverse proxy (Caddy in Docker).
TRUSTED_PROXY_NETS = [
    ipaddress.ip_network(n.strip())
    for n in os.environ.get("YTDL_TRUSTED_PROXIES", "172.16.0.0/12,127.0.0.1/32").split(",")
    if n.strip()
]

# The only cookies forwarded to yt-dlp: YouTube login/session + visitor identity.
ALLOWED_COOKIE_NAMES = {
    "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO",
    "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
    "SIDCC", "PREF", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA", "YSC",
    "__Secure-ROLLOUT_TOKEN",
}
MAX_COOKIES = 40
COOKIE_DIR = tempfile.mkdtemp(prefix="ytdl-cookies-")
os.chmod(COOKIE_DIR, 0o700)

TICKETS = {}
TICKETS_LOCK = threading.Lock()

RATE = {}            # ip -> list[timestamps]
STREAMS = {}         # ip -> active stream count
RATE_LOCK = threading.Lock()


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def extract_video_id(raw):
    """Return the 11-char video ID from a YouTube URL or bare ID, else None."""
    if not raw or not isinstance(raw, str) or len(raw) > 2048:
        return None
    raw = raw.strip()
    if VIDEO_ID_RE.match(raw):
        return raw
    try:
        parsed = urlparse(raw)
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


def canonical_url(video_id):
    return f"https://www.youtube.com/watch?v={video_id}"


def sanitize_filename(name):
    clean = re.sub(r'[\x00-\x1f\x7f/\\?%*:|"<>]', "-", name or "video")
    clean = re.sub(r"\s+", " ", clean).strip().strip(".")
    return (clean or "video")[:120]


def friendly_error(stderr):
    text = (stderr or "").lower()
    if "private video" in text:
        return "This video is private."
    if "sign in to confirm your age" in text or "age-restricted" in text:
        return "This video is age-restricted and can't be downloaded."
    if "sign in to confirm" in text:
        return "YouTube is temporarily blocking the server. Please try again later."
    if "video unavailable" in text or "not available" in text:
        return "This video is unavailable."
    if "live event" in text or "is_live" in text:
        return "Live streams can't be downloaded."
    return "Could not process this video."


def _clean_cookie_field(value):
    return re.sub(r"[\t\r\n]", "", str(value or ""))[:4096]


def write_cookie_file(cookies):
    """Write allowlisted YouTube cookies to a private file. Returns path or None."""
    if not isinstance(cookies, list) or not cookies:
        return None
    lines = []
    for c in cookies[:MAX_COOKIES]:
        if not isinstance(c, dict):
            continue
        domain = _clean_cookie_field(c.get("domain"))
        name = _clean_cookie_field(c.get("name"))
        value = _clean_cookie_field(c.get("value"))
        if not name or not value or name not in ALLOWED_COOKIE_NAMES:
            continue
        if domain.lstrip(".") not in ("youtube.com", "www.youtube.com"):
            continue
        path = _clean_cookie_field(c.get("path")) or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        flag = "TRUE" if domain.startswith(".") else "FALSE"
        try:
            exp = str(int(c.get("expirationDate") or 2147483647))
        except (TypeError, ValueError):
            exp = "2147483647"
        lines.append("\t".join([domain, flag, path, secure, exp, name, value]))
    if not lines:
        return None
    fd, path = tempfile.mkstemp(dir=COOKIE_DIR, suffix=".txt")  # created 0600
    with os.fdopen(fd, "w") as f:
        f.write("# Netscape HTTP Cookie File\n" + "\n".join(lines) + "\n")
    return path


def delete_file(path):
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def _run_dump_json(extra_args, video_id, cookie_file=None):
    cmd = [
        YTDLP_BIN,
        "--remote-components", "ejs:github",
        "--dump-json",
        "--no-playlist",
        *(["--cookies", cookie_file] if cookie_file else []),
        *extra_args,
        "--",
        canonical_url(video_id),
    ]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=METADATA_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return None


def fetch_metadata(video_id, cookie_file=None):
    # Attempt 1: default clients (with JS challenge solver); attempt 2: mobile/TV clients.
    last_err = ""
    for extra in ([], ["--extractor-args", FALLBACK_EXTRACTOR_ARGS]):
        proc = _run_dump_json(extra, video_id, cookie_file)
        if proc is None:
            last_err = "timeout"
            continue
        if proc.returncode == 0:
            try:
                return json.loads(proc.stdout)
            except json.JSONDecodeError:
                last_err = "invalid json"
                continue
        last_err = proc.stderr or proc.stdout or ""
    errors = [l for l in last_err.splitlines() if "ERROR" in l] or [last_err[-400:]]
    log(f"yt-dlp metadata error for {video_id} (cookies={'yes' if cookie_file else 'no'}): {errors[-1][:400]}")
    if last_err == "timeout":
        raise UserError("Timed out while reading video details.", 504)
    if "sign in to confirm you" in last_err.lower() and not cookie_file:
        raise UserError(
            "YouTube is asking for a sign-in check. Turn on \"Use my YouTube session\" in the extension popup and try again.",
            502, code="auth_required",
        )
    raise UserError(friendly_error(last_err), 502)


def _is_https_url(url):
    return isinstance(url, str) and url.startswith("https://")


def _codec_rank(vcodec):
    vcodec = vcodec or ""
    if vcodec.startswith("avc"):
        return 3
    if vcodec.startswith(("vp9", "vp09")):
        return 2
    if vcodec.startswith("av01"):
        return 1
    return 0


def pick_formats(info, quality):
    formats = [f for f in info.get("formats", []) if _is_https_url(f.get("url"))]
    height = QUALITY_HEIGHTS[quality]

    if height is None:
        audio = [f for f in formats if f.get("acodec") != "none" and f.get("vcodec") == "none"] or formats
        return {"type": "audio", "audio_url": audio[-1]["url"] if audio else None}

    prog = [
        f for f in formats
        if f.get("acodec") != "none" and f.get("vcodec") != "none" and (f.get("height") or 0) <= height
    ]
    if height <= 720 and prog and prog[-1].get("height") == height:
        return {"type": "progressive", "url": prog[-1]["url"]}

    # Height first: YouTube serves 1440p/2160p only as VP9 or AV1, so filtering on
    # AVC would silently cap 4K at 1080p. Codec is only a tie-break within the
    # tallest height: AVC (plays in QuickTime), then VP9 (most widely decodable
    # of the rest), then AV1. SDR beats HDR. Later entries in yt-dlp's list are
    # better, so the index is the final tie-break.
    video = [f for f in formats if f.get("vcodec") != "none" and (f.get("height") or 0) <= height]
    best_video = None
    if video:
        top = max(f.get("height") or 0 for f in video)
        best_video = max(
            (f for f in video if (f.get("height") or 0) == top),
            key=lambda f: (_codec_rank(f.get("vcodec")), (f.get("dynamic_range") or "SDR") == "SDR",
                           video.index(f)),
        )["url"]

    audio = [f for f in formats if f.get("acodec") != "none" and f.get("vcodec") == "none"]
    aac = [f for f in audio if (f.get("acodec") or "").startswith("mp4a")]
    best_audio = aac[-1]["url"] if aac else (audio[-1]["url"] if audio else None)

    if not best_video and formats:
        best_video = formats[-1]["url"]
    return {"type": "remux", "video_url": best_video, "audio_url": best_audio}


def ffmpeg_command(spec):
    def inp(url):
        return ["-protocol_whitelist", FFMPEG_PROTOCOLS, "-i", url]

    frag = ["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"]
    base = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y"]
    if spec["type"] == "audio":
        return base + inp(spec["audio_url"]) + ["-vn", "-c:a", "libmp3lame", "-b:a", "320k", "-f", "mp3", "pipe:1"]
    if spec["type"] == "progressive":
        return base + inp(spec["url"]) + ["-c", "copy"] + frag
    if spec.get("audio_url"):
        return (base + inp(spec["video_url"]) + inp(spec["audio_url"])
                + ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac"] + frag)
    return base + inp(spec["video_url"]) + ["-c", "copy"] + frag


class UserError(Exception):
    def __init__(self, message, status=400, code=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def prune_tickets(now):
    expired = [t for t, v in TICKETS.items() if v["expires"] < now]
    for t in expired:
        del TICKETS[t]


def check_rate(ip):
    now = time.time()
    with RATE_LOCK:
        hits = [t for t in RATE.get(ip, []) if now - t < 60]
        if len(hits) >= REQUESTS_PER_MINUTE:
            RATE[ip] = hits
            return False
        hits.append(now)
        RATE[ip] = hits
        if len(RATE) > 10000:
            for k in [k for k, v in RATE.items() if not v or now - v[-1] > 60]:
                del RATE[k]
        return True


def acquire_stream(ip):
    with RATE_LOCK:
        total = sum(STREAMS.values())
        if total >= MAX_STREAMS_GLOBAL or STREAMS.get(ip, 0) >= MAX_STREAMS_PER_IP:
            return False
        STREAMS[ip] = STREAMS.get(ip, 0) + 1
        return True


def release_stream(ip):
    with RATE_LOCK:
        n = STREAMS.get(ip, 0) - 1
        if n <= 0:
            STREAMS.pop(ip, None)
        else:
            STREAMS[ip] = n


class RemoteHandler(BaseHTTPRequestHandler):
    server_version = "YTDL"
    sys_version = ""
    timeout = 120

    # ---------- helpers ----------
    def _via_proxy(self):
        try:
            peer = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        return any(peer in net for net in TRUSTED_PROXY_NETS)

    def _client_ip(self):
        # Behind Caddy the peer is the proxy; Caddy overwrites X-Forwarded-For
        # with the real client address, so only trust it from the proxy.
        if self._via_proxy():
            fwd = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if fwd:
                return fwd
        return self.client_address[0]

    def _send_cors(self):
        # The extension's background worker uses host_permissions and is not
        # subject to CORS; only reflect extension origins so ordinary websites
        # can't drive this API from a visitor's browser.
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message, code=None):
        payload = {"success": False, "error": message}
        if code:
            payload["code"] = code
        self._json(status, payload)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            raise UserError("Invalid Content-Length")
        if length <= 0 or length > MAX_BODY_BYTES:
            raise UserError("Request body missing or too large", 413 if length > 0 else 400)
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise UserError("Invalid JSON")
        if not isinstance(data, dict):
            raise UserError("Invalid JSON")
        return data

    # ---------- routes ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/status":
            self._json(200, {"status": "online", "version": "3.1.0", "engine": "yt-dlp"})
            return

        if not check_rate(self._client_ip()):
            self._error(429, "Too many requests. Please slow down.")
            return

        try:
            if parsed.path == "/info":
                self._handle_info(qs)
            elif parsed.path == "/stream":
                self._handle_stream(qs)
            else:
                self._error(404, "Not found")
        except UserError as e:
            self._error(e.status, e.message, e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            log(f"Unhandled GET error: {e!r}")
            try:
                self._error(500, "Internal server error")
            except Exception:
                pass

    def do_POST(self):
        parsed = urlparse(self.path)
        if not check_rate(self._client_ip()):
            self._error(429, "Too many requests. Please slow down.")
            return
        try:
            if parsed.path == "/prepare":
                self._handle_prepare()
            else:
                self._error(404, "Not found")
        except UserError as e:
            self._error(e.status, e.message, e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            log(f"Unhandled POST error: {e!r}")
            try:
                self._error(500, "Internal server error")
            except Exception:
                pass

    def _handle_info(self, qs):
        video_id = extract_video_id(qs.get("url", [None])[0])
        if not video_id:
            raise UserError("A valid YouTube video URL is required")
        info = fetch_metadata(video_id)
        heights = [f.get("height") for f in info.get("formats", []) if isinstance(f.get("height"), int)]
        max_height = max(heights) if heights else 1080
        self._json(200, {
            "success": True,
            "title": str(info.get("title") or "")[:300],
            "author": str(info.get("uploader") or info.get("channel") or "")[:200],
            "thumbnail": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
            "max_height": max_height,
            "has_4k": max_height >= 2160,
        })

    def _handle_prepare(self):
        data = self._read_json()
        video_id = extract_video_id(data.get("url"))
        if not video_id:
            raise UserError("A valid YouTube video URL is required")
        quality = data.get("format", "1080p")
        if quality not in QUALITY_HEIGHTS:
            raise UserError("Unsupported format")

        cookies = data.get("cookies")
        if cookies and not self._via_proxy():
            # Cookies must only ever travel over HTTPS (terminated by Caddy).
            raise UserError("Session cookies are only accepted over HTTPS.", 400)
        cookie_file = write_cookie_file(cookies)
        cookies = None
        data.pop("cookies", None)
        try:
            info = fetch_metadata(video_id, cookie_file)
        finally:
            delete_file(cookie_file)
        if info.get("is_live"):
            raise UserError("Live streams can't be downloaded.")
        spec = pick_formats(info, quality)
        if not (spec.get("audio_url") or spec.get("url") or spec.get("video_url")):
            raise UserError("No downloadable formats found for this video.", 502)
        title = sanitize_filename(data.get("title") or info.get("title") or "video")
        ext = "mp3" if quality == "mp3" else "mp4"
        heights = [f.get("height") for f in info.get("formats", []) if isinstance(f.get("height"), int)]
        max_height = max(heights) if heights else 1080

        now = time.time()
        ticket = secrets.token_urlsafe(24)
        with TICKETS_LOCK:
            prune_tickets(now)
            if len(TICKETS) >= MAX_TICKETS:
                raise UserError("Server is busy. Please try again shortly.", 503)
            TICKETS[ticket] = {
                "spec": spec,
                "title": title,
                "ext": ext,
                "expires": now + TICKET_TTL_SECONDS,
                "ip": self._client_ip(),
            }

        self._json(200, {
            "success": True, "ticket": ticket, "title": title, "ext": ext,
            "max_height": max_height, "has_4k": max_height >= 2160,
        })

    def _handle_stream(self, qs):
        ticket = qs.get("ticket", [None])[0]
        if not ticket or len(ticket) > 64:
            raise UserError("Missing ticket")

        with TICKETS_LOCK:
            job = TICKETS.pop(ticket, None)  # single use
        if not job or job["expires"] < time.time():
            raise UserError("Ticket is invalid or expired", 403)

        ip = self._client_ip()
        if not acquire_stream(ip):
            raise UserError("Too many downloads in progress. Please wait for one to finish.", 429)

        proc = None
        try:
            spec = job["spec"]
            content_type = "audio/mpeg" if spec["type"] == "audio" else "video/mp4"
            cmd = ffmpeg_command(spec)

            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", content_type)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            encoded = urllib.parse.quote(f"{job['title']}.{job['ext']}")
            self.send_header("Content-Disposition", f"attachment; filename=\"{encoded}\"; filename*=UTF-8''{encoded}")
            self.end_headers()

            deadline = time.time() + STREAM_MAX_SECONDS
            while time.time() < deadline:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        finally:
            if proc is not None:
                if proc.poll() is None:
                    proc.kill()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
            release_stream(ip)

    def log_message(self, format, *args):
        # Log method + path only; query strings carry tickets.
        log(f"{self._client_ip()} {self.command} {urlparse(self.path).path} {args[1] if len(args) > 1 else ''}")


def main():
    if not os.path.exists(YTDLP_BIN):
        log(f"yt-dlp not found at {YTDLP_BIN}")
        sys.exit(1)
    httpd = ThreadingHTTPServer((BIND, PORT), RemoteHandler)
    httpd.daemon_threads = True
    log(f"VPS Downloader Engine running on {BIND}:{PORT}...")
    try:
        httpd.serve_forever()
    finally:
        shutil.rmtree(COOKIE_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
