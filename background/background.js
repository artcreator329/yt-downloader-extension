// background.js - Service Worker with Persistent Task & History Tracking (v2.3)

const DEFAULT_SERVER_URL = 'https://ytapi.aigility.digital';
const TASKS_STORAGE_KEY = 'yt_download_tasks';

// The only engines the extension will ever talk to.
const ALLOWED_SERVER_URLS = [
  DEFAULT_SERVER_URL,
  'http://localhost:8989',
  'http://127.0.0.1:8989'
];
const ALLOWED_FORMATS = ['4k', '2160p', '1440p', '1080p', '720p', '360p', 'mp3'];
const ALLOWED_EXTS = ['mp4', 'mp3', 'm4a', 'webm', 'jpg'];
const ALLOWED_OPEN_URL_HOSTS = ['buymeacoffee.com', 'www.buymeacoffee.com'];
const VIDEO_ID_RE = /^[\w-]{11}$/;

// Opt-in only: the minimal YouTube cookies yt-dlp needs to pass a bot check.
const SESSION_COOKIE_NAMES = new Set([
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  'SIDCC', 'PREF', 'VISITOR_INFO1_LIVE', 'VISITOR_PRIVACY_METADATA', 'YSC',
  '__Secure-ROLLOUT_TOKEN'
]);

// Returns the user's minimal YouTube session cookies, or [] unless ALL hold:
// the user granted the optional "cookies" permission (the opt-in switch), and
// the engine is reached over HTTPS.
async function getSessionCookies(serverUrl) {
  try {
    if (!serverUrl.startsWith('https://')) return [];
    if (!chrome.cookies) return [];
    const granted = await chrome.permissions.contains({ permissions: ['cookies'] });
    if (!granted) return [];
    const all = await chrome.cookies.getAll({ domain: 'youtube.com' });
    return all
      .filter((c) => SESSION_COOKIE_NAMES.has(c.name) && ['.youtube.com', 'youtube.com', 'www.youtube.com'].includes(c.domain))
      .map((c) => ({
        domain: c.domain,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        expirationDate: c.expirationDate
      }));
  } catch (e) {
    console.warn('Could not read YouTube session cookies:', e);
    return [];
  }
}

function isAllowedServerUrl(url) {
  return typeof url === 'string' && ALLOWED_SERVER_URLS.includes(url.replace(/\/+$/, ''));
}

async function getServerUrl() {
  try {
    const res = await chrome.storage.local.get(['customServerUrl']);
    return isAllowedServerUrl(res.customServerUrl) ? res.customServerUrl.replace(/\/+$/, '') : DEFAULT_SERVER_URL;
  } catch (e) {
    return DEFAULT_SERVER_URL;
  }
}

function sanitizeFilename(name) {
  return String(name || 'youtube_video')
    .replace(/[\x00-\x1f\x7f/\\?%*:|"<>~]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .substring(0, 120) || 'youtube_video';
}

function safeExt(ext, fallback) {
  return ALLOWED_EXTS.includes(ext) ? ext : fallback;
}

function isValidVideoId(id) {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

function thumbnailUrl(videoId) {
  return isValidVideoId(videoId) ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '';
}

// Only YouTube thumbnail images may be downloaded through DOWNLOAD_DIRECT.
function isAllowedDirectDownload(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'img.youtube.com' || u.hostname === 'i.ytimg.com') && u.pathname.startsWith('/vi/');
  } catch (e) {
    return false;
  }
}

function isAllowedOpenUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_OPEN_URL_HOSTS.includes(u.hostname);
  } catch (e) {
    return false;
  }
}

function extractVideoId(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtube.com')) {
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
      if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/shorts/')[1].split(/[?&#]/)[0];
      if (parsed.pathname.startsWith('/embed/')) return parsed.pathname.split('/embed/')[1].split(/[?&#]/)[0];
    }
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.substring(1).split(/[?&#]/)[0];
    }
  } catch (e) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/))([\w-]{11})/);
    return match ? match[1] : null;
  }
  return null;
}

// ----------------- Preparing (server-side check before the download starts) -----------------
// In memory only: the service worker stays alive while the /prepare fetch is pending.
const PREPARING = new Map();
let prepareSeq = 0;

function startPreparing(info) {
  const key = `prep-${Date.now()}-${++prepareSeq}`;
  PREPARING.set(key, { key, startTime: Date.now(), ...info });
  return key;
}

function endPreparing(key) {
  PREPARING.delete(key);
}

// ----------------- Browser download UI -----------------
// Never hide the browser's own download UI: when the browser is set to ask
// what to do with each file, its prompt only appears through that UI.
// v1.2.0 hid it during downloads, so make sure it is switched back on.
function restoreBrowserDownloadUi() {
  try {
    if (chrome.downloads.setUiOptions) {
      chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
    }
  } catch (e) {
    // Unsupported browser: nothing to restore.
  }
}

restoreBrowserDownloadUi();
chrome.runtime.onStartup.addListener(restoreBrowserDownloadUi);

// ----------------- Persistent Task Store -----------------
async function getStoredTasks() {
  try {
    const data = await chrome.storage.local.get([TASKS_STORAGE_KEY]);
    return data[TASKS_STORAGE_KEY] || [];
  } catch (e) {
    return [];
  }
}

async function saveTasks(tasks) {
  try {
    // Keep at most 40 tasks (most recent first)
    const trimmed = tasks.slice(0, 40);
    await chrome.storage.local.set({ [TASKS_STORAGE_KEY]: trimmed });
  } catch (e) {
    console.error('Error saving tasks:', e);
  }
}

async function addOrUpdateTask(task) {
  const tasks = await getStoredTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    tasks[idx] = { ...tasks[idx], ...task };
  } else {
    tasks.unshift(task);
  }
  await saveTasks(tasks);
}

// Sync tasks with live Chrome downloads API
async function getLiveTasks() {
  const storedTasks = await getStoredTasks();
  if (!storedTasks || storedTasks.length === 0) {
    return { active: [], history: [], preparing: Array.from(PREPARING.values()) };
  }

  const liveDownloads = await new Promise((resolve) => {
    chrome.downloads.search({}, (items) => resolve(items || []));
  });

  const downloadMap = new Map();
  for (const item of liveDownloads) {
    downloadMap.set(item.id, item);
  }

  let updated = false;
  for (const task of storedTasks) {
    const item = downloadMap.get(task.id);
    if (item) {
      task.state = item.state; // 'in_progress', 'complete', 'interrupted'
      task.bytesReceived = item.bytesReceived || 0;
      task.totalBytes = item.totalBytes || 0;
      if (item.filename) task.filename = item.filename;
      if (item.error) task.error = item.error;
      if (task.totalBytes > 0) {
        task.percent = Math.min(100, Math.round((task.bytesReceived / task.totalBytes) * 100));
      } else if (item.state === 'complete') {
        task.percent = 100;
      }
      updated = true;
    }
  }

  if (updated) {
    await saveTasks(storedTasks);
  }

  const active = storedTasks.filter((t) => t.state === 'in_progress');
  const history = storedTasks.filter((t) => t.state !== 'in_progress');

  const preparing = Array.from(PREPARING.values());
  return { active, history, preparing, all: storedTasks };
}

// Monitor Chrome downloads for live progress
chrome.downloads.onChanged.addListener(async (delta) => {
  const tasks = await getStoredTasks();
  const task = tasks.find((t) => t.id === delta.id);
  if (!task) return;

  if (delta.state) {
    task.state = delta.state.current;
    if (delta.state.current === 'complete') {
      task.percent = 100;
      task.endTime = Date.now();
    } else if (delta.state.current === 'interrupted') {
      task.error = delta.error?.current || 'Download interrupted';
    }
  }

  if (delta.bytesReceived) {
    task.bytesReceived = delta.bytesReceived.current;
  }
  if (delta.totalBytes) {
    task.totalBytes = delta.totalBytes.current;
  }
  if (task.totalBytes > 0) {
    task.percent = Math.min(100, Math.round((task.bytesReceived / task.totalBytes) * 100));
  }
  if (delta.filename) {
    task.filename = delta.filename.current;
  }

  await saveTasks(tasks);
});

// Context Menus
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-yt-1080p',
    title: 'Download Video (1080p HD)',
    contexts: ['link'],
    targetUrlPatterns: [
      '*://*.youtube.com/watch*',
      '*://youtu.be/*',
      '*://*.youtube.com/shorts/*'
    ]
  });

  chrome.contextMenus.create({
    id: 'download-yt-mp3',
    title: 'Download Audio (320kbps MP3)',
    contexts: ['link'],
    targetUrlPatterns: [
      '*://*.youtube.com/watch*',
      '*://youtu.be/*',
      '*://*.youtube.com/shorts/*'
    ]
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.linkUrl) return;
  const vid = extractVideoId(info.linkUrl);
  if (!isValidVideoId(vid)) return;
  const videoUrl = `https://www.youtube.com/watch?v=${vid}`;
  const serverUrl = await getServerUrl();
  const format = info.menuItemId === 'download-yt-mp3' ? 'mp3' : '1080p';

  const prepKey = startPreparing({ title: 'YouTube video', format, videoId: vid });
  try {
    const cookies = await getSessionCookies(serverUrl);
    const prepRes = await fetch(`${serverUrl}/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: videoUrl,
        format: format,
        title: 'YouTube_Download',
        ...(cookies.length ? { cookies } : {})
      })
    });
    const prepData = await prepRes.json();
    if (prepData.success && typeof prepData.ticket === 'string') {
      const finalTitle = sanitizeFilename(prepData.title || 'YouTube_Download');
      const finalExt = safeExt(prepData.ext, format === 'mp3' ? 'mp3' : 'mp4');

      chrome.downloads.download(
        {
          url: `${serverUrl}/stream?ticket=${encodeURIComponent(prepData.ticket)}`,
          filename: `${finalTitle}.${finalExt}`,
          saveAs: false
        },
        async (downloadId) => {
          if (!chrome.runtime.lastError && downloadId) {
            await addOrUpdateTask({
              id: downloadId,
              videoId: vid,
              title: finalTitle,
              format: format,
              ext: finalExt,
              videoUrl: videoUrl,
              thumbnail: thumbnailUrl(vid),
              startTime: Date.now(),
              state: 'in_progress',
              bytesReceived: 0,
              totalBytes: 0,
              percent: 0,
              filename: `${finalTitle}.${finalExt}`,
              error: null
            });
          }
          endPreparing(prepKey);
        }
      );
    } else {
      endPreparing(prepKey);
    }
  } catch (e) {
    endPreparing(prepKey);
    console.error('Context menu download failed:', e);
  }
});

// Runtime Messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (!sender || sender.id !== chrome.runtime.id || !request || typeof request.action !== 'string') {
    return false;
  }

  if (request.action === 'EXTRACT_ID') {
    sendResponse({ videoId: extractVideoId(request.url) });
    return true;
  }

  if (request.action === 'GET_CONFIG') {
    getServerUrl().then((serverUrl) => {
      sendResponse({ serverUrl, defaultServerUrl: DEFAULT_SERVER_URL });
    });
    return true;
  }

  if (request.action === 'SET_CONFIG') {
    if (!isAllowedServerUrl(request.serverUrl)) {
      sendResponse({ success: false, error: 'Server URL is not allowed' });
      return true;
    }
    chrome.storage.local.set({ customServerUrl: request.serverUrl.replace(/\/+$/, '') }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'CHECK_LOCAL_SERVER') {
    getServerUrl().then((serverUrl) => {
      fetch(`${serverUrl}/status`, { method: 'GET' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => sendResponse({ success: true, data, serverUrl }))
        .catch((err) => sendResponse({ success: false, error: err.message, serverUrl }));
    });
    return true;
  }

  if (request.action === 'FETCH_METADATA') {
    if (!isValidVideoId(request.videoId)) {
      sendResponse({ success: false, error: 'Invalid video ID' });
      return true;
    }
    const watchUrl = `https://www.youtube.com/watch?v=${request.videoId}`;
    getServerUrl().then((serverUrl) => {
      fetch(`${serverUrl}/info?url=${encodeURIComponent(watchUrl)}`, { method: 'GET' })
        .then((res) => res.json())
        .then((data) => {
          if (data && data.success) {
            sendResponse({
              success: true,
              data: {
                title: String(data.title || ''),
                author: String(data.author || ''),
                thumbnail: thumbnailUrl(request.videoId),
                maxHeight: Number(data.max_height) || 1080,
                has4k: data.has_4k === true
              }
            });
          } else {
            throw new Error('Fallback');
          }
        })
        .catch(() => {
          const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
          fetch(oembedUrl)
            .then((res) => res.json())
            .then((oembed) => {
              sendResponse({
                success: true,
                data: {
                  title: String(oembed.title || ''),
                  author: String(oembed.author_name || ''),
                  thumbnail: thumbnailUrl(request.videoId),
                  maxHeight: 1080,
                  has4k: false
                }
              });
            })
            .catch((err) => sendResponse({ success: false, error: err.message }));
        });
    });
    return true;
  }

  if (request.action === 'DOWNLOAD_STREAM' || request.action === 'LOCAL_DOWNLOAD') {
    let prepKey = null;
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        const format = request.format || '1080p';
        if (!ALLOWED_FORMATS.includes(format)) {
          sendResponse({ success: false, error: 'Unsupported format' });
          return;
        }
        const cleanTitle = sanitizeFilename(request.title || 'YouTube_Video');
        const videoId = isValidVideoId(request.videoId) ? request.videoId : extractVideoId(request.videoUrl);
        if (!isValidVideoId(videoId)) {
          sendResponse({ success: false, error: 'Invalid YouTube video' });
          return;
        }
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        prepKey = startPreparing({ title: cleanTitle, format, videoId });

        // Step 1: Pre-flight validation. Session cookies are only included
        // when the user opted in and the engine is HTTPS.
        const cookies = await getSessionCookies(serverUrl);
        const prepRes = await fetch(`${serverUrl}/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: videoUrl,
            format: format,
            title: cleanTitle,
            ...(cookies.length ? { cookies } : {})
          })
        });

        const prepData = await prepRes.json().catch(() => ({}));

        if (!prepRes.ok || !prepData.success || typeof prepData.ticket !== 'string') {
          const errMsg = String(prepData.error || `Server error (${prepRes.status})`).substring(0, 200);
          endPreparing(prepKey);
          sendResponse({ success: false, error: errMsg, code: prepData.code === 'auth_required' ? 'auth_required' : undefined });
          return;
        }

        // Step 2: Trigger Chrome Native Download Manager
        const finalTitle = sanitizeFilename(prepData.title || cleanTitle);
        const finalExt = safeExt(prepData.ext, format === 'mp3' ? 'mp3' : 'mp4');
        const streamUrl = `${serverUrl}/stream?ticket=${encodeURIComponent(prepData.ticket)}`;

        chrome.downloads.download(
          {
            url: streamUrl,
            filename: `${finalTitle}.${finalExt}`,
            saveAs: false
          },
          async (downloadId) => {
            const startError = chrome.runtime.lastError;
            if (startError) {
              endPreparing(prepKey);
              sendResponse({ success: false, error: startError.message });
            } else {
              // Store persistent task
              await addOrUpdateTask({
                id: downloadId,
                videoId: videoId,
                title: finalTitle,
                format: format,
                ext: finalExt,
                videoUrl: videoUrl,
                thumbnail: thumbnailUrl(videoId),
                startTime: Date.now(),
                state: 'in_progress',
                bytesReceived: 0,
                totalBytes: 0,
                percent: 0,
                filename: `${finalTitle}.${finalExt}`,
                error: null
              });

              endPreparing(prepKey);
              sendResponse({
                success: true,
                downloadId: downloadId,
                filename: `${finalTitle}.${finalExt}`
              });
            }
          }
        );
      } catch (err) {
        endPreparing(prepKey);
        console.error('Download preparation failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Task & History Queries
  if (request.action === 'GET_ALL_TASKS') {
    getLiveTasks().then((res) => sendResponse(res));
    return true;
  }

  if (request.action === 'CANCEL_TASK') {
    if (request.downloadId) {
      chrome.downloads.cancel(request.downloadId, () => {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }

  if (request.action === 'SHOW_IN_FOLDER') {
    if (request.downloadId) {
      chrome.downloads.show(request.downloadId);
      sendResponse({ success: true });
    } else if (chrome.downloads.showDefaultFolder) {
      chrome.downloads.showDefaultFolder();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }

  if (request.action === 'OPEN_FILE') {
    if (request.downloadId) {
      chrome.downloads.open(request.downloadId);
      sendResponse({ success: true });
    }
    return true;
  }

  if (request.action === 'CLEAR_HISTORY') {
    (async () => {
      const { active } = await getLiveTasks();
      await saveTasks(active);
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'REMOVE_TASK') {
    (async () => {
      const tasks = await getStoredTasks();
      const filtered = tasks.filter((t) => t.id !== request.downloadId);
      await saveTasks(filtered);
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'OPEN_URL') {
    if (!isAllowedOpenUrl(request.url)) {
      sendResponse({ success: false, error: 'URL not allowed' });
      return true;
    }
    chrome.tabs.create({ url: request.url });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'DOWNLOAD_DIRECT') {
    if (!isAllowedDirectDownload(request.url)) {
      sendResponse({ success: false, error: 'URL not allowed' });
      return true;
    }
    const cleanName = sanitizeFilename(request.filename || 'video');
    const ext = 'jpg';
    chrome.downloads.download(
      {
        url: request.url,
        filename: `${cleanName}.${ext}`,
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }

  if (request.action === 'OPEN_DOWNLOADS_PAGE') {
    chrome.tabs.create({ url: 'chrome://downloads' });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'OPEN_FOLDER') {
    try {
      if (chrome.downloads.showDefaultFolder) {
        chrome.downloads.showDefaultFolder();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }
});
