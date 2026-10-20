// content.js - Native In-Page YouTube Downloader (VPS Cloud Engine v2.3)

(function () {
  'use strict';

  let currentVideoId = null;
  let observer = null;
  let isDownloading = false;

  function getVideoId() {
    const url = window.location.href;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  function getVideoTitle() {
    const titleEl =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('#title h1 yt-formatted-string') ||
      document.querySelector('h1.title.style-scope.ytd-video-primary-info-renderer') ||
      document.querySelector('yt-formatted-string.ytd-reel-player-header-renderer');
    if (titleEl && titleEl.textContent.trim()) {
      return titleEl.textContent.trim();
    }
    return document.title.replace(/\s*-\s*YouTube$/, '').trim();
  }

  // Detect maximum available video resolution from page player response
  function getAvailableResolutions() {
    let maxHeight = 1080;
    try {
      for (const script of document.scripts) {
        const text = script.textContent;
        if (text && text.includes('ytInitialPlayerResponse')) {
          const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?});(?:var|\s*<\/script>|$)/);
          if (match) {
            const data = JSON.parse(match[1]);
            const formats = data?.streamingData?.adaptiveFormats || [];
            const heights = formats.map((f) => f.height).filter(Boolean);
            if (heights.length > 0) {
              maxHeight = Math.max(...heights);
              break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Could not extract max video height:', e);
    }

    return {
      maxHeight,
      has4k: maxHeight >= 2160,
      has1440p: maxHeight >= 1440,
      has1080p: maxHeight >= 1080
    };
  }

  function showToast(message, actionLabel = null, onAction = null) {
    const existing = document.querySelector('.yt-dl-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'yt-dl-toast';

    const span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(span);

    if (actionLabel && onAction) {
      const btn = document.createElement('button');
      btn.className = 'yt-dl-toast-btn';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => {
        onAction();
        toast.remove();
      });
      toast.appendChild(btn);
    }

    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 4500);
  }

  // state: 'preparing' (spinner) | 'started' (check mark)
  function setButtonState(btn, state) {
    if (state === 'started') {
      btn.classList.remove('downloading');
      btn.classList.add('started');
      btn.setAttribute('aria-busy', 'false');
      btn.innerHTML = `
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
        <span>Download started</span>
      `;
    } else {
      btn.classList.add('downloading');
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = `
        <span class="yt-dl-spinner" aria-hidden="true"></span>
        <span>Preparing…</span>
      `;
    }
  }

  function resetButton(btn) {
    isDownloading = false;
    if (!btn) return;
    btn.classList.remove('downloading', 'started');
    btn.setAttribute('aria-busy', 'false');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
      </svg>
      <span>Download</span>
    `;
  }

  function triggerDownload(quality) {
    if (isDownloading) {
      showToast('Still preparing your last download. One moment…');
      return;
    }

    const videoId = getVideoId();
    if (!videoId) return;

    const resInfo = getAvailableResolutions();
    if (quality === '4k' && !resInfo.has4k) {
      showToast(`⚠️ 4K is unavailable for this video (Max: ${resInfo.maxHeight}p). Please select 1080p.`);
      return;
    }

    const title = getVideoTitle();
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const btn = document.querySelector('.yt-dl-btn');

    // 1. Direct Thumbnail Download
    if (quality === 'thumbnail') {
      const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      chrome.runtime.sendMessage({
        action: 'DOWNLOAD_DIRECT',
        url: thumbUrl,
        filename: `${title} - HD Thumbnail`,
        ext: 'jpg'
      });
      showToast('Downloading HD thumbnail...');
      return;
    }

    // 2. Video / Audio Stream Download
    isDownloading = true;
    if (btn) setButtonState(btn, 'preparing');
    showToast(`Preparing ${quality.toUpperCase()}… this usually takes 10–30 seconds.`);

    chrome.runtime.sendMessage({
      action: 'DOWNLOAD_STREAM',
      videoUrl: videoUrl,
      videoId: videoId,
      format: quality,
      title: title
    }, (res) => {
      if (chrome.runtime.lastError || !res || !res.success) {
        resetButton(btn);
        showToast(`Download error: ${res?.error || chrome.runtime.lastError?.message || 'Could not start download'}`);
        return;
      }

      if (btn) setButtonState(btn, 'started');
      showToast(`✅ Download started: "${title}" (${quality.toUpperCase()}). Click the extension icon to watch progress.`);
      setTimeout(() => resetButton(btn), 4000);
    });
  }

  function copyYtDlpCommand() {
    const videoId = getVideoId();
    if (!videoId) return;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const cmd = `yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" --merge-output-format mp4 "${url}"`;
    navigator.clipboard.writeText(cmd).then(() => {
      showToast('Copied yt-dlp command to clipboard!');
    });
  }

  function createDownloadMenu(btnContainer) {
    const menu = document.createElement('div');
    menu.className = 'yt-dl-dropdown';
    menu.id = 'yt-dl-dropdown-menu';

    const resInfo = getAvailableResolutions();
    const is4kDisabled = !resInfo.has4k;

    menu.innerHTML = `
      <div class="yt-dl-header">
        <span>Cloud 4K Engine</span>
        <span class="yt-dl-status-dot online" style="background:#10b981;" title="VPS Engine Online"></span>
      </div>
      
      <div class="yt-dl-section-title">Video (MP4 Lossless)</div>
      <div class="yt-dl-item ${is4kDisabled ? 'disabled' : ''}" data-action="4k" title="${is4kDisabled ? `4K not available for this video (Max: ${resInfo.maxHeight}p)` : '4K Ultra HD (2160p)'}">
        <div class="yt-dl-item-left">
          <span>🎬 4K Ultra HD</span>
        </div>
        <span class="yt-dl-badge ${is4kDisabled ? 'na' : 'gold'}">${is4kDisabled ? 'N/A' : '4K'}</span>
      </div>
      <div class="yt-dl-item" data-action="1080p">
        <div class="yt-dl-item-left">
          <span>🎬 1080p Full HD</span>
        </div>
        <span class="yt-dl-badge hd">1080p</span>
      </div>
      <div class="yt-dl-item" data-action="720p">
        <div class="yt-dl-item-left">
          <span>🎬 720p HD</span>
        </div>
        <span class="yt-dl-badge">720p</span>
      </div>
      <div class="yt-dl-item" data-action="360p">
        <div class="yt-dl-item-left">
          <span>🎬 360p Fast</span>
        </div>
        <span class="yt-dl-badge">360p</span>
      </div>

      <div class="yt-dl-divider"></div>

      <div class="yt-dl-section-title">Audio & Assets</div>
      <div class="yt-dl-item" data-action="mp3">
        <div class="yt-dl-item-left">
          <span>🎵 320kbps MP3 Audio</span>
        </div>
        <span class="yt-dl-badge audio">MP3</span>
      </div>
      <div class="yt-dl-item" data-action="thumbnail">
        <div class="yt-dl-item-left">
          <span>🖼️ MaxRes Thumbnail</span>
        </div>
        <span class="yt-dl-badge">JPG</span>
      </div>

      <div class="yt-dl-divider"></div>

      <div class="yt-dl-item" data-action="open-folder">
        <div class="yt-dl-item-left">
          <span>📁 Open ~/Downloads Folder</span>
        </div>
      </div>
      <div class="yt-dl-item" data-action="copy-cmd">
        <div class="yt-dl-item-left">
          <span>📋 Copy CLI yt-dlp</span>
        </div>
      </div>

      <div class="yt-dl-divider"></div>

      <!-- Buy Me A Coffee -->
      <div class="yt-dl-item coffee-item" data-action="coffee" title="Support the creator">
        <div class="yt-dl-item-left">
          <span>☕ Buy Me a Coffee</span>
        </div>
        <span class="yt-dl-badge coffee">Support</span>
      </div>
    `;

    menu.querySelectorAll('.yt-dl-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.remove('active');
        const action = item.getAttribute('data-action');
        if (action === 'open-folder') {
          chrome.runtime.sendMessage({ action: 'OPEN_FOLDER' });
          showToast('Opening Downloads folder...');
        } else if (action === 'copy-cmd') {
          copyYtDlpCommand();
        } else if (action === 'coffee') {
          chrome.runtime.sendMessage({ action: 'OPEN_URL', url: 'https://buymeacoffee.com/chriswenfeng' });
        } else {
          triggerDownload(action);
        }
      });
    });

    btnContainer.appendChild(menu);
    return menu;
  }

  function injectDownloadButton() {
    const videoId = getVideoId();
    if (!videoId) return;

    if (document.getElementById('yt-downloader-btn-container')) {
      return;
    }

    const targets = [
      '#top-level-buttons-computed',
      'ytd-watch-metadata #actions #top-level-buttons-computed',
      'ytd-watch-metadata #top-level-buttons-computed',
      '#actions-inner #top-level-buttons-computed',
      'ytd-menu-renderer #top-level-buttons-computed',
      '#menu #top-level-buttons-computed',
      'ytd-watch-metadata #actions',
      '#actions.ytd-watch-metadata',
      'ytd-reel-player-overlay-renderer #actions'
    ];

    let targetContainer = null;
    for (const selector of targets) {
      const el = document.querySelector(selector);
      if (el) {
        targetContainer = el;
        break;
      }
    }

    if (!targetContainer) return;

    const container = document.createElement('div');
    container.id = 'yt-downloader-btn-container';

    const button = document.createElement('button');
    button.className = 'yt-dl-btn';
    button.title = 'Download via Contabo Cloud Engine';
    button.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
      </svg>
      <span>Download</span>
    `;

    const dropdown = createDownloadMenu(container);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.classList.remove('active');
      }
    });

    container.appendChild(button);
    targetContainer.appendChild(container);
  }

  function initObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      const vid = getVideoId();
      if (vid && (!document.getElementById('yt-downloader-btn-container') || vid !== currentVideoId)) {
        currentVideoId = vid;
        injectDownloadButton();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener('yt-navigate-finish', () => {
    currentVideoId = getVideoId();
    setTimeout(injectDownloadButton, 300);
    setTimeout(injectDownloadButton, 1000);
  });

  window.addEventListener('load', () => {
    currentVideoId = getVideoId();
    injectDownloadButton();
    initObserver();
  });

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'GET_PAGE_VIDEO_INFO') {
      const resInfo = getAvailableResolutions();
      sendResponse({
        videoId: getVideoId(),
        title: getVideoTitle(),
        url: window.location.href,
        maxHeight: resInfo.maxHeight,
        has4k: resInfo.has4k
      });
      return true;
    }
  });

  injectDownloadButton();
  initObserver();
})();
