#!/usr/bin/env python3
import os
import sys
import json
import tempfile
import importlib.util
import base64
import zipfile
import urllib.request
import urllib.error

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANDING_DIR = os.path.join(BASE_DIR, 'landing')
# Credentials come from the environment, never from this file:
#   export CLOUDFLARE_ACCOUNT_ID=...
#   export CLOUDFLARE_API_TOKEN=...
ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN', '')
SCRIPT_NAME = 'yt-downloader'

def build_zip():
    zip_path = os.path.join(tempfile.mkdtemp(), 'YT_downloader_chromeExt.zip')
    files_to_include = [
        'manifest.json',
        'README.md',
        'background/background.js',
        'content/content.js',
        'content/content.css',
        'popup/popup.html',
        'popup/popup.js',
        'popup/popup.css',
        'icons/icon16.png',
        'icons/icon48.png',
        'icons/icon128.png',
    ]
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for rel_path in files_to_include:
            full_path = os.path.join(BASE_DIR, rel_path)
            arcname = os.path.join('YT_downloader_chromeExt', rel_path)
            zf.write(full_path, arcname)
    with open(zip_path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')

def get_icon_base64():
    icon_path = os.path.join(BASE_DIR, 'icons', 'icon128.png')
    with open(icon_path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')

def get_og_base64():
    # Social preview image; regenerate from landing/og-image.html (see its header).
    with open(os.path.join(LANDING_DIR, 'og.png'), 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')

def sync_replica_css():
    # Keep the how-to mock-ups styled exactly like the shipped extension UI.
    spec = importlib.util.spec_from_file_location('sync_replica_css', os.path.join(LANDING_DIR, 'sync_replica_css.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.sync()

def main():
    if not ACCOUNT_ID or not TOKEN:
        sys.exit("❌ Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in your environment first.")

    print("🎨 Syncing extension UI styles into the how-to mock-ups...")
    sync_replica_css()

    print("📦 Building Extension ZIP...")
    b64_zip = build_zip()
    b64_icon = get_icon_base64()
    b64_og = get_og_base64()

    print("📄 Reading landing/index.html...")
    with open(os.path.join(LANDING_DIR, 'index.html'), 'r', encoding='utf-8') as f:
        html_content = f.read()

    worker_code = f"""// Cloudflare Worker: yt-downloader
const B64_ZIP = "{b64_zip}";
const B64_ICON = "{b64_icon}";
const B64_OG = "{b64_og}";
const HTML_PAGE = {repr(html_content)};

function base64ToUint8Array(base64) {{
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {{
    bytes[i] = bin.charCodeAt(i);
  }}
  return bytes;
}}

export default {{
  async fetch(request, env, ctx) {{
    const url = new URL(request.url);

    if (url.pathname === '/download' || url.pathname === '/YT_downloader_chromeExt.zip') {{
      const zipBytes = base64ToUint8Array(B64_ZIP);
      return new Response(zipBytes, {{
        headers: {{
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="YT_downloader_chromeExt.zip"',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*'
        }}
      }});
    }}

    if (url.pathname === '/og.png') {{
      return new Response(base64ToUint8Array(B64_OG), {{
        headers: {{
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400'
        }}
      }});
    }}

    if (url.pathname === '/favicon.ico' || url.pathname === '/icon.png') {{
      const iconBytes = base64ToUint8Array(B64_ICON);
      return new Response(iconBytes, {{
        headers: {{
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        }}
      }});
    }}

    return new Response(HTML_PAGE, {{
      headers: {{
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'public, max-age=300'
      }}
    }});
  }}
}};
"""
    with open(os.path.join(LANDING_DIR, 'worker.js'), 'w', encoding='utf-8') as f:
        f.write(worker_code)

    print("🚀 Uploading to Cloudflare Workers...")
    boundary = '----CloudflareWorkerBoundary' + '123456789'
    metadata = {'main_module': 'worker.js', 'compatibility_date': '2024-01-01'}
    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="metadata"\r\n'
        f'Content-Type: application/json\r\n\r\n'
        f'{json.dumps(metadata)}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
        f'Content-Type: application/javascript+module\r\n\r\n'
        f'{worker_code}\r\n'
        f'--{boundary}--\r\n'
    ).encode('utf-8')

    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}'
    req = urllib.request.Request(url, data=body, method='PUT')
    req.add_header('Authorization', f'Bearer {TOKEN}')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')

    try:
        with urllib.request.urlopen(req) as resp:
            res = json.loads(resp.read().decode())
            if res.get('success'):
                print("✅ Deployed successfully to https://yt.aigility.digital/")
            else:
                print("❌ Deploy failed:", res)
    except urllib.error.HTTPError as e:
        print("❌ HTTP Error:", e.code, e.read().decode())

if __name__ == '__main__':
    main()
