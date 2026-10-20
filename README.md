# 🎬 YT Downloader: YouTube Video & Audio Downloader (Chrome Extension)

A browser extension (Manifest V3) that saves YouTube videos in **4K, 1080p, 720p or 360p MP4**, or as **320kbps MP3**, straight to your Downloads folder.

- Works on **Chrome, Edge, Brave and Opera**, on Windows, macOS, Linux and ChromeOS.
- Nothing to install besides the extension: the heavy lifting (yt-dlp + ffmpeg) runs on a download engine server.
- No ads, no third-party converter sites (loader.to, y2mate, …).

Website and download: **https://yt.aigility.digital**

---

## 🚀 Install

1. Get the extension: download the ZIP from [yt.aigility.digital](https://yt.aigility.digital) and unzip it, or clone this repository.
2. Open your browser's extensions page: `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin the **YT Downloader** icon (🧩 → 📌) so it's always in your toolbar.

---

## 🎮 How to use it

Everything happens in the extension popup:

1. **Open the popup.** Open any YouTube video or Short and click the YT Downloader icon. The video loads by itself (or paste a link and click **Load**). The badge shows **⚡ Cloud Engine Online** when the engine is reachable.
2. **Pick a format** under **Select Format**:
   - 🎬 **4K Ultra HD**: 2160p MP4, only when the video has it. 4K files play in VLC or a browser; QuickTime may not open them.
   - 🎬 **1080p Full HD**, 🎬 **720p HD**, 🎬 **360p Fast**
   - 🎵 **320kbps MP3 Audio**
3. **Follow progress.** A card shows **Preparing** (the engine checks the video, usually 10–30 s) → **Downloading** → **✓ Saved to Downloads**, with **Show in folder**. If your browser asks what to do with the file, choose **Save**.

Extras: save the **MaxRes thumbnail**, open your **Downloads** folder, or copy a ready-made **yt-dlp** command. The **Tasks** tab keeps your download history.

### If YouTube asks you to sign in

Downloads sometimes stop with *"YouTube is asking for a sign-in check"*, because YouTube rate-limits server traffic. Switch on **Use my YouTube session** in the popup (allow the permission if asked), make sure you're signed in to YouTube in this browser, and try again.

---

## 🔒 Privacy & security

- **What the engine receives:** the YouTube video ID, the chosen format, and (like any web server) your IP address in its request logs. Video files are streamed straight through to your browser and never stored on the server.
- **YouTube session (opt-in, off by default):** uses the optional `cookies` permission. Only a short allowlist of YouTube login cookies is sent, only over HTTPS, and the engine deletes them right after looking up the video. They are never logged or stored. Switching it off removes the permission.
- **Hardened engine:** only YouTube video links are accepted (rebuilt from the 11-character video ID), downloads use short-lived single-use tickets, requests are rate-limited, and raw errors are never sent back to clients.
- **Extension:** only talks to the engine and YouTube, ignores messages from other extensions or pages, and never inserts page or server text as HTML.

Found a security issue? Please open a GitHub issue without exploit details, or contact the maintainer privately.

---

## 🖥️ Self-hosting the download engine

By default the extension uses the maintainer's hosted engine at `https://ytapi.aigility.digital`. To run your own:

**Requirements:** a Linux server with Python 3.10+, `ffmpeg`, a domain name, and an HTTPS reverse proxy (the examples use [Caddy](https://caddyserver.com)). [Deno](https://deno.com) is recommended so yt-dlp can solve YouTube's JavaScript challenges.

1. **Install the engine**

   ```bash
   sudo mkdir -p /opt/yt-downloader && cd /opt/yt-downloader
   sudo cp /path/to/this/repo/server/remote_vps_server.py server.py
   sudo python3 -m venv venv && sudo venv/bin/pip install -U yt-dlp
   sudo apt install -y ffmpeg
   ```

2. **Run it as a service.** Example `/etc/systemd/system/yt-downloader.service`:

   ```ini
   [Unit]
   Description=YT Downloader engine
   After=network-online.target

   [Service]
   WorkingDirectory=/opt/yt-downloader
   ExecStart=/opt/yt-downloader/venv/bin/python3 /opt/yt-downloader/server.py
   # Listen only where your reverse proxy can reach it, never on the public IP
   Environment=YTDL_BIND=127.0.0.1
   Environment=YTDL_TRUSTED_PROXIES=127.0.0.1/32
   Restart=always
   NoNewPrivileges=yes
   PrivateTmp=yes
   ProtectSystem=full

   [Install]
   WantedBy=multi-user.target
   ```

   Then: `sudo systemctl enable --now yt-downloader`.

   | Setting | Default | Purpose |
   |---|---|---|
   | `YTDL_BIND` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` (or a Docker bridge IP) behind a proxy. |
   | `YTDL_PORT` | `8989` | Port to listen on. |
   | `YTDLP_BIN` | `/opt/yt-downloader/venv/bin/yt-dlp` | Path to yt-dlp. |
   | `YTDL_TRUSTED_PROXIES` | `172.16.0.0/12,127.0.0.1/32` | Networks your reverse proxy connects from. Only these may pass `X-Forwarded-For`, and session cookies are only accepted through them (i.e. over HTTPS). |

3. **Put it behind HTTPS.** Example Caddyfile:

   ```caddyfile
   ytapi.example.com {
       request_body {
           max_size 64KB
       }
       reverse_proxy 127.0.0.1:8989 {
           flush_interval -1
           header_up X-Forwarded-For {remote_host}
       }
   }
   ```

4. **Point the extension at your engine:** in `background/background.js` set `DEFAULT_SERVER_URL` to your HTTPS address, and in `manifest.json` replace `https://ytapi.aigility.digital/*` in `host_permissions` with yours. Reload the extension.

Servers in data centres are often hit by YouTube's sign-in check, so users of a self-hosted engine will usually need the **Use my YouTube session** switch.

---

## 📁 Project structure

```text
├── manifest.json            # Extension manifest (MV3)
├── popup/                   # Popup UI: format picker, progress card, Tasks tab
├── background/              # Service worker: talks to the engine, starts downloads
├── content/                 # Content script: reads the current video for the popup
├── icons/
├── server/
│   ├── remote_vps_server.py # The download engine (see Self-hosting)
│   ├── test_pick_formats.py # Tests for the engine's format selection
│   └── server.py            # Older local engine (not used by the current extension)
├── start_server.*, setup_autostart.*, uninstall_autostart.command,
│   YouTube Downloader.app   # Helpers for the older local engine
├── landing/                 # Website: page, social image, Cloudflare Worker deploy script
├── LICENSE
└── README.md
```

To deploy the website, set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your environment and run `python3 landing/deploy.py`.

---

## 📄 License

Released under the [MIT License](LICENSE). You're free to use, copy, modify and share this project, as long as the copyright notice is kept. It comes with no warranty.

Downloading videos may be restricted by YouTube's Terms of Service and by copyright law where you live. Only download content you have the right to save.
