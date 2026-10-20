#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLIST_PATH="$HOME/Library/LaunchAgents/com.ytdownloader.engine.plist"

echo "============================================================"
echo "    YouTube Downloader - Auto-Start Setup (Click & Play)    "
echo "============================================================"

# Ensure venv exists
if [ ! -d "$DIR/server/venv" ]; then
    echo "📦 Initializing Python environment..."
    python3 -m venv "$DIR/server/venv"
    "$DIR/server/venv/bin/pip" install yt-dlp
fi

# Stop existing if loaded
launchctl unload "$PLIST_PATH" 2>/dev/null

mkdir -p "$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/ytdownloader"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"

cat << EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ytdownloader.engine</string>
    <key>ProgramArguments</key>
    <array>
        <string>$DIR/server/venv/bin/python3</string>
        <string>$DIR/server/server.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/engine.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/engine.err</string>
</dict>
</plist>
EOF

# Load the daemon
launchctl load "$PLIST_PATH"

sleep 1

if curl -s http://127.0.0.1:8989/status | grep -q "online"; then
    echo ""
    echo "🎉 SUCCESS! The Native Downloader Engine is now permanently installed."
    echo "⚡ It will run silently in the background and auto-start whenever you turn on your Mac."
    echo "👉 You never need to touch Terminal or launch anything again!"
    echo "============================================================"
else
    echo "⚠️ Service registered. Please reload Chrome."
fi

read -p "Press Enter to exit..."
