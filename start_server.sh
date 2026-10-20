#!/bin/bash
cd "$(dirname "$0")"

if [ ! -d "server/venv" ]; then
  echo "📦 First-time setup: Setting up isolated Python environment..."
  python3 -m venv server/venv
  ./server/venv/bin/pip install --upgrade pip
  ./server/venv/bin/pip install -r server/requirements.txt
fi

echo "🚀 Starting Native YouTube Downloader Engine on http://localhost:8989..."
./server/venv/bin/python3 server/server.py
