# 🎬 YouTube Video Downloader (Turnkey Cloud Engine - Zero Setup)

A 100% private, high-speed YouTube video and audio downloader for Google Chrome (Manifest V3).

**Zero local commands. Zero terminals. Zero third-party web services.**  
Powered by your own private Contabo VPS streaming engine (`https://ytapi.aigility.digital`), users on **Windows, macOS, Linux, or ChromeOS** simply install the extension and download instantly!

---

## 🚀 How End Users Use It (Turnkey & Out-of-the-Box)

No Python, ffmpeg, or background scripts need to be installed or double-clicked on the user's PC. Everything works straight from the browser:

1. Open Google Chrome and go to `chrome://extensions`.
2. Toggle on **"Developer mode"** in the top-right corner.
3. Click **"Load unpacked"** and select the `YT_downloader_chromeExt` folder.
4. Pin the red **YT Downloader** icon (📌) to your Chrome toolbar.
5. Go to any YouTube video!

---

## 🎮 Features & Download Options

### Extension Popup
Click the **YT Downloader** icon in your Chrome toolbar on any YouTube video:
- Loads the video in the current tab automatically, or accepts a pasted link (including YouTube Shorts) via **Load**.
- **Select Format**, 1 click each:
  - 🎬 **4K Ultra HD** (2160p MP4, when the video has it)
  - 🎬 **1080p Full HD** (video + audio muxed)
  - 🎬 **720p HD** (fast download)
  - 🎬 **360p Fast** (compact file)
  - 🎵 **320kbps MP3 Audio**
- Quick tools: **MaxRes Thumbnail**, open the **Downloads** folder, copy a **yt-dlp** command.
- A progress card shows Preparing → Downloading → Saved, and the **Tasks** tab keeps your history.
- Shows real-time connection status to your Contabo VPS engine.

---

## ⚙️ Architecture: Live Stream Gateway (Zero VPS Disk Storage)

- **Engine Location:** Private Contabo VPS behind Caddy at `https://ytapi.aigility.digital` (HTTPS only; the engine itself listens on the Docker bridge, not the public IP), managed via systemd (`yt-downloader.service`).
- **Zero Disk Usage:** The VPS uses piped stdin/stdout streams (`ffmpeg -c:v copy -c:a aac -movflags frag_keyframe+empty_moov+default_base_moof pipe:1`) to stream media chunks in RAM directly to the user's browser. No video files are ever saved or stored on the VPS.
- **Native Browser Downloads:** When a download starts, Chrome's native download manager receives the stream, writing directly to the user's local `Downloads` folder on their Mac or Windows machine.
- **Privacy:** 100% owned and operated on your own server. No third-party converter services (e.g. loader.to, y2mate, ssyoutube) are ever contacted.
- **Optional YouTube session (opt-in):** If YouTube shows a bot check, users can turn on **Use my YouTube session** in the popup. This grants the optional `cookies` permission; only a short allowlist of YouTube login cookies is sent, only over HTTPS, and the server deletes them immediately after reading the video's details. They are never logged or stored. Turning the switch off revokes the permission.

---

## 📁 File Structure

```text
YT_downloader_chromeExt/
├── manifest.json                 # Chrome Extension Manifest V3
├── popup/                        # Extension popup UI & format picker
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content/                      # Content script (reads the current video for the popup)
│   ├── content.js
│   └── content.css
├── background/                   # Service worker & download gateway
│   └── background.js
├── icons/                        # Extension icons
├── server/                       # Local companion engine scripts (optional fallback)
│   ├── server.py
│   └── requirements.txt
├── LICENSE                       # MIT License
└── README.md                     # Documentation
```

---

## 📄 License

Released under the [MIT License](LICENSE). You're free to use, copy, modify and share this project, as long as the copyright notice is kept. It comes with no warranty.

Downloading videos may be restricted by YouTube's Terms of Service and by copyright law where you live. Only download content you have the right to save.
