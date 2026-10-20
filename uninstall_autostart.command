#!/bin/bash
PLIST_PATH="$HOME/Library/LaunchAgents/com.ytdownloader.engine.plist"

echo "Stopping and removing YouTube Downloader Auto-Start Service..."
launchctl unload "$PLIST_PATH" 2>/dev/null
rm -f "$PLIST_PATH"

echo "✅ Removed! The engine will no longer auto-start."
read -p "Press Enter to exit..."
