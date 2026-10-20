#!/bin/bash
cd "$(dirname "$0")"

echo "======================================================"
echo "    YouTube Downloader - Native Companion Engine     "
echo "======================================================"

if ! command -v python3 &> /dev/null; then
  echo "Error: Python 3 is not installed. Please install Python 3."
  read -p "Press Enter to exit..."
  exit 1
fi

if [ ! -d "server/venv" ]; then
  echo "📦 First-time setup: Setting up isolated Python environment..."
  python3 -m venv server/venv
  ./server/venv/bin/pip install --upgrade pip
  ./server/venv/bin/pip install -r server/requirements.txt
fi

echo "🚀 Starting Native YouTube Downloader Engine on http://localhost:8989..."
echo "📁 Downloads will be saved directly to: ~/Downloads"
echo "======================================================"
echo ""
./server/venv/bin/python3 server/server.py
