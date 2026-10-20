// popup.js - YouTube Video Downloader UI (v2.3)

document.addEventListener('DOMContentLoaded', async () => {
  // Elements - Navigation
  const tabBtnDownloader = document.getElementById('tab-btn-downloader');
  const tabBtnTasks = document.getElementById('tab-btn-tasks');
  const tabViewDownloader = document.getElementById('tab-view-downloader');
  const tabViewTasks = document.getElementById('tab-view-tasks');
  const tasksBadge = document.getElementById('tasks-badge');

  // Elements - Downloader View
  const videoUrlInput = document.getElementById('video-url-input');
  const fetchBtn = document.getElementById('fetch-btn');
  const videoCard = document.getElementById('video-card');
  const videoThumbnail = document.getElementById('video-thumbnail');
  const videoTitleEl = document.getElementById('video-title');
  const videoAuthorEl = document.getElementById('video-author');
  const downloadSection = document.getElementById('download-section');
  const emptyState = document.getElementById('empty-state');
  const statusBanner = document.getElementById('status-banner');
  const serverStatusBadge = document.getElementById('server-status-badge');

  // 4K Card Elements
  const card4k = document.getElementById('card-4k');
  const sub4k = document.getElementById('sub-4k');
  const chip4k = document.getElementById('chip-4k');

  // Elements - Active Progress Card
  const progressCard = document.getElementById('progress-card');
  const progressStatusText = document.getElementById('progress-status-text');
  const progressPercentage = document.getElementById('progress-percentage');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressSpeed = document.getElementById('progress-speed');
  const progressCancelBtn = document.getElementById('progress-cancel-btn');
  const progressSpinner = document.getElementById('progress-spinner');
  const progressFile = document.getElementById('progress-file');
  const progressFolderBtn = document.getElementById('progress-folder-btn');
  const progressDownloadsBtn = document.getElementById('progress-downloads-btn');

  // Elements - Tasks View
  const activeTasksCount = document.getElementById('active-tasks-count');
  const activeTasksList = document.getElementById('active-tasks-list');
  const historyTasksList = document.getElementById('history-tasks-list');
  const clearHistoryBtn = document.getElementById('clear-history-btn');

  // Tools & External Links
  const dlThumbBtn = document.getElementById('dl-thumb-btn');
  const openFolderBtn = document.getElementById('open-folder-btn');
  const copyCmdBtn = document.getElementById('copy-cmd-btn');
  const coffeeLink = document.getElementById('coffee-link');

  // Session opt-in
  const sessionCard = document.getElementById('session-card');
  const sessionToggle = document.getElementById('session-toggle');
  const COOKIE_PERMISSION = { permissions: ['cookies'] };

  // State
  let currentVideoId = null;
  let currentVideoTitle = 'YouTube Video';
  let currentMaxHeight = 1080;
  let currentHas4k = false;
  let isServerOnline = false;
  let activeDownloadId = null;
  let doneDownloadId = null;
  let taskPollTimer = null;
  let localStart = null;      // download the user just clicked, until the background answers
  let pinnedError = null;     // { message, until }
  let lastTasks = { active: [], history: [], preparing: [] };
  const DONE_CARD_MS = 15000;

  // Initialize
  syncSessionToggle();
  checkEngineStatus();
  inspectCurrentTab();
  loadTasks();
  taskPollTimer = setInterval(loadTasks, 1200);

  // ----------------- Tab Navigation -----------------
  function switchTab(tabName) {
    if (tabName === 'downloader') {
      tabBtnDownloader.classList.add('active');
      tabBtnTasks.classList.remove('active');
      tabViewDownloader.classList.remove('hidden');
      tabViewTasks.classList.add('hidden');
    } else {
      tabBtnTasks.classList.add('active');
      tabBtnDownloader.classList.remove('active');
      tabViewTasks.classList.remove('hidden');
      tabViewDownloader.classList.add('hidden');
      loadTasks();
    }
  }

  tabBtnDownloader.addEventListener('click', () => switchTab('downloader'));
  tabBtnTasks.addEventListener('click', () => switchTab('tasks'));

  // ----------------- Buy Me a Coffee -----------------
  if (coffeeLink) {
    coffeeLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://buymeacoffee.com/chriswenfeng' });
    });
  }

  // ----------------- YouTube Session Opt-in -----------------
  // Consent == the optional "cookies" permission. Nothing can read cookies
  // until the user grants it here, and turning the switch off revokes it.
  function syncSessionToggle() {
    chrome.permissions.contains(COOKIE_PERMISSION, (granted) => {
      sessionToggle.checked = Boolean(granted);
    });
  }

  sessionToggle.addEventListener('change', () => {
    sessionCard.classList.remove('attention');
    if (sessionToggle.checked) {
      chrome.permissions.request(COOKIE_PERMISSION, (granted) => {
        sessionToggle.checked = Boolean(granted);
        showStatus(granted ? 'YouTube session enabled for downloads.' : 'Permission not granted.', granted ? 'success' : 'info');
      });
    } else {
      chrome.permissions.remove(COOKIE_PERMISSION, () => {
        syncSessionToggle();
        showStatus('YouTube session turned off. No cookies will be sent.', 'info');
      });
    }
  });

  // ----------------- Event Listeners -----------------
  fetchBtn.addEventListener('click', handleManualUrlFetch);
  videoUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleManualUrlFetch();
  });

  // Download Cards
  document.querySelectorAll('.dl-card').forEach((card) => {
    const spin = el('span', 'spinner card-spinner');
    spin.setAttribute('aria-hidden', 'true');
    card.appendChild(spin);
    card.addEventListener('click', () => {
      const quality = card.getAttribute('data-quality');
      if (quality === '4k' && card.classList.contains('disabled')) {
        showStatus(`⚠️ 4K is not available for this video (Max: ${currentMaxHeight}p). Please choose 1080p.`, 'error');
        return;
      }
      startCloudDownload(quality, card);
    });
  });

  function setCardsBusy(activeCard, busy) {
    document.querySelectorAll('.dl-card').forEach((c) => {
      c.classList.toggle('busy', busy);
      c.classList.toggle('loading', busy && c === activeCard);
      c.setAttribute('aria-busy', busy && c === activeCard ? 'true' : 'false');
    });
  }

  // Quick Tools
  dlThumbBtn.addEventListener('click', downloadThumbnail);
  openFolderBtn.addEventListener('click', openDownloadsFolder);
  copyCmdBtn.addEventListener('click', copyYtDlpCmd);

  // Task Actions
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'CLEAR_HISTORY' }, () => {
        loadTasks();
        showStatus('Download history cleared.', 'info');
      });
    });
  }

  progressDownloadsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_DOWNLOADS_PAGE' });
  });

  progressFolderBtn.addEventListener('click', () => {
    if (doneDownloadId) {
      chrome.runtime.sendMessage({ action: 'SHOW_IN_FOLDER', downloadId: doneDownloadId });
    }
  });

  if (progressCancelBtn) {
    progressCancelBtn.addEventListener('click', () => {
      if (activeDownloadId) {
        chrome.runtime.sendMessage({ action: 'CANCEL_TASK', downloadId: activeDownloadId }, () => {
          progressCard.classList.add('hidden');
          activeDownloadId = null;
          loadTasks();
          showStatus('Download cancelled.', 'info');
        });
      }
    });
  }

  // ----------------- VPS Server Status -----------------
  function checkEngineStatus() {
    const spin = el('span', 'spinner');
    spin.setAttribute('aria-hidden', 'true');
    serverStatusBadge.replaceChildren(spin, document.createTextNode('Connecting…'));
    serverStatusBadge.className = 'badge badge-checking';
    serverStatusBadge.title = 'Checking the download engine';
    chrome.runtime.sendMessage({ action: 'CHECK_LOCAL_SERVER' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.success) {
        isServerOnline = false;
        serverStatusBadge.textContent = '● Offline';
        serverStatusBadge.className = 'badge badge-offline';
        serverStatusBadge.title = 'The download engine is not reachable right now. Try again in a minute.';
        return;
      }
      isServerOnline = true;
      serverStatusBadge.textContent = '⚡ Cloud Engine Online';
      serverStatusBadge.className = 'badge badge-connected';
      serverStatusBadge.title = `Connected to ${res.serverUrl}`;
    });
  }

  function showStatus(msg, type = 'info') {
    statusBanner.textContent = msg;
    statusBanner.className = `status-banner ${type}`;
    statusBanner.classList.remove('hidden');
    setTimeout(() => {
      statusBanner.classList.add('hidden');
    }, 4500);
  }

  function extractVideoId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  // ----------------- 4K Availability -----------------
  function updateQualityAvailability(maxHeight, has4k) {
    currentMaxHeight = maxHeight || 1080;
    currentHas4k = Boolean(has4k || currentMaxHeight >= 2160);

    if (!card4k) return;

    if (!currentHas4k) {
      card4k.classList.add('disabled');
      card4k.setAttribute('disabled', 'true');
      card4k.title = `4K not available for this video (Max: ${currentMaxHeight}p)`;
      if (sub4k) sub4k.textContent = `Unavailable (Max ${currentMaxHeight}p)`;
      if (chip4k) {
        chip4k.className = 'chip chip-disabled';
        chip4k.textContent = 'N/A';
      }
    } else {
      card4k.classList.remove('disabled');
      card4k.removeAttribute('disabled');
      card4k.title = '4K Ultra HD (2160p MP4, VP9/AV1). Plays in VLC or a browser; QuickTime may not open it.';
      if (sub4k) sub4k.textContent = '2160p · VLC, not QuickTime';
      if (chip4k) {
        chip4k.className = 'chip chip-gold';
        chip4k.textContent = '4K';
      }
    }
  }

  // ----------------- Inspect Active Tab -----------------
  async function inspectCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return;

      const vid = extractVideoId(tab.url);
      if (vid) {
        currentVideoId = vid;
        chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_VIDEO_INFO' }, (res) => {
          if (chrome.runtime.lastError || !res || !res.title) {
            fetchVideoMetadata(vid);
            return;
          }
          updateVideoUI(vid, res.title, 'YouTube Video', null, res.maxHeight, res.has4k);
        });
      }
    } catch (e) {
      console.warn('Could not inspect tab:', e);
    }
  }

  function handleManualUrlFetch() {
    const url = videoUrlInput.value.trim();
    if (!url) {
      showStatus('Please enter a YouTube link', 'error');
      return;
    }
    const vid = extractVideoId(url);
    if (!vid) {
      showStatus('Invalid YouTube URL.', 'error');
      return;
    }
    currentVideoId = vid;
    fetchVideoMetadata(vid);
  }

  function setFetchLoading(loading) {
    fetchBtn.disabled = loading;
    if (loading) {
      const spin = el('span', 'spinner');
      spin.setAttribute('aria-hidden', 'true');
      fetchBtn.replaceChildren(spin, document.createTextNode('Loading'));
    } else {
      fetchBtn.textContent = 'Load';
    }
  }

  function fetchVideoMetadata(vid) {
    setFetchLoading(true);
    chrome.runtime.sendMessage({ action: 'FETCH_METADATA', videoId: vid }, (res) => {
      setFetchLoading(false);
      if (chrome.runtime.lastError || !res || !res.success || !res.data) {
        updateVideoUI(vid, `YouTube Video (${vid})`, 'YouTube');
        showStatus('Video loaded.', 'info');
        return;
      }
      const data = res.data;
      updateVideoUI(vid, data.title, data.author, data.thumbnail, data.maxHeight, data.has4k);
      showStatus('Video loaded!', 'success');
    });
  }

  function updateVideoUI(vid, title, author, thumbUrl, maxHeight, has4k) {
    currentVideoTitle = title;
    videoTitleEl.textContent = title;
    videoAuthorEl.textContent = author || 'YouTube';
    videoThumbnail.src = safeThumb(thumbUrl || `https://img.youtube.com/vi/${vid}/hqdefault.jpg`);

    updateQualityAvailability(maxHeight, has4k);

    videoCard.classList.remove('hidden');
    downloadSection.classList.remove('hidden');
    emptyState.classList.add('hidden');
  }

  // ----------------- Start Cloud Download -----------------
  function startCloudDownload(quality, card) {
    if (!currentVideoId) {
      showStatus('Please load a video first.', 'error');
      return;
    }
    if (localStart) return;

    const videoUrl = `https://www.youtube.com/watch?v=${currentVideoId}`;
    localStart = { format: quality, title: currentVideoTitle, videoId: currentVideoId };
    pinnedError = null;
    sessionCard.classList.remove('attention');
    setCardsBusy(card, true);
    updatePinnedCard();

    chrome.runtime.sendMessage({
      action: 'DOWNLOAD_STREAM',
      videoUrl: videoUrl,
      videoId: currentVideoId,
      format: quality,
      title: currentVideoTitle
    }, (res) => {
      localStart = null;
      setCardsBusy(null, false);
      if (chrome.runtime.lastError || !res || !res.success) {
        if (res && res.code === 'auth_required') {
          sessionCard.classList.add('attention');
        }
        pinnedError = {
          message: res?.error || chrome.runtime.lastError?.message || 'Failed to start download',
          until: Date.now() + 10000
        };
        updatePinnedCard();
        return;
      }
      activeDownloadId = res.downloadId;
      loadTasks();
    });
  }

  // ----------------- Pinned Progress Card -----------------
  // One clear status for the most relevant download:
  // Preparing → Downloading → Saving → Saved (or an error).
  function renderPinned(view) {
    progressCard.classList.remove('hidden', 'is-done', 'is-error');
    if (view.kind === 'done') progressCard.classList.add('is-done');
    if (view.kind === 'error') progressCard.classList.add('is-error');

    progressSpinner.classList.toggle('hidden', !['preparing', 'downloading', 'saving'].includes(view.kind));
    progressStatusText.textContent = view.title;
    progressPercentage.textContent = view.pct == null ? '' : `${view.pct}%`;
    progressFile.textContent = view.file || '';
    progressSpeed.textContent = view.detail || '';

    if (view.pct == null) {
      progressBarFill.classList.add('indeterminate');
      progressBarFill.style.width = '';
    } else {
      progressBarFill.classList.remove('indeterminate');
      progressBarFill.style.width = `${Math.max(view.pct, 3)}%`;
    }

    activeDownloadId = view.cancelId || null;
    doneDownloadId = view.folderId || null;
    progressCancelBtn.classList.toggle('hidden', !view.cancelId);
    progressFolderBtn.classList.toggle('hidden', !view.folderId);
    progressDownloadsBtn.classList.toggle('hidden', !view.openDownloads);
  }

  function fmtLabel(format) {
    return String(format || '').toUpperCase();
  }

  function updatePinnedCard() {
    const { active, history, preparing } = lastTasks;
    const now = Date.now();

    if (pinnedError && now < pinnedError.until) {
      renderPinned({ kind: 'error', title: "Couldn't start the download", detail: pinnedError.message, pct: 100 });
      return;
    }
    pinnedError = null;

    const prep = localStart || preparing[0];
    if (localStart || (prep && active.length === 0)) {
      renderPinned({
        kind: 'preparing',
        title: `Preparing ${fmtLabel(prep.format)}…`,
        file: prep.title,
        detail: 'Checking the video on the server (usually 10–30 seconds)',
        pct: null
      });
      return;
    }

    if (active.length > 0) {
      const t = active[0];
      const recv = formatBytes(t.bytesReceived);
      const total = formatBytes(t.totalBytes);
      const allBytes = t.totalBytes > 0 && t.bytesReceived >= t.totalBytes;
      if (allBytes) {
        renderPinned({
          kind: 'saving',
          title: `Saving ${fmtLabel(t.format)}…`,
          file: t.title,
          detail: 'Choose Save if your browser asks.',
          pct: 100,
          cancelId: t.id,
          openDownloads: true
        });
      } else {
        renderPinned({
          kind: 'downloading',
          title: `Downloading ${fmtLabel(t.format)}`,
          file: t.title,
          detail: total ? `${recv} of ${total}` : (recv ? `${recv} received` : 'Starting…'),
          pct: total ? clampPercent(t.percent) : null,
          cancelId: t.id
        });
      }
      return;
    }

    const done = history.find((t) => t.state === 'complete' && t.endTime && now - t.endTime < DONE_CARD_MS);
    if (done) {
      renderPinned({
        kind: 'done',
        title: '✓ Saved to Downloads',
        file: done.title,
        detail: formatBytes(done.totalBytes || done.bytesReceived),
        pct: 100,
        folderId: done.id
      });
      return;
    }

    progressCard.classList.add('hidden');
    activeDownloadId = null;
    doneDownloadId = null;
  }

  // ----------------- Tasks & History Management -----------------
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1000) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }

  function loadTasks() {
    chrome.runtime.sendMessage({ action: 'GET_ALL_TASKS' }, (res) => {
      if (chrome.runtime.lastError || !res) return;

      const active = res.active || [];
      const history = res.history || [];
      const preparing = res.preparing || [];
      lastTasks = { active, history, preparing };

      // Update Tab Badge
      const runningCount = active.length + preparing.length;
      if (runningCount > 0) {
        tasksBadge.textContent = runningCount;
        tasksBadge.classList.remove('hidden');
        activeTasksCount.textContent = runningCount;
      } else {
        tasksBadge.classList.add('hidden');
        activeTasksCount.textContent = '0';
      }

      // 1. Pinned progress card on the Downloader tab
      updatePinnedCard();

      // 2. Render Active Tasks List in Tasks Tab
      activeTasksList.replaceChildren();
      for (const prep of preparing) {
        const sub = el('div', 'task-card-sub');
        const spin = el('span', 'spinner');
        spin.style.width = '10px';
        spin.style.height = '10px';
        sub.append(formatChip(prep.format), spin, el('span', null, 'Preparing on the server…'));
        const thumb = prep.videoId ? `https://img.youtube.com/vi/${prep.videoId}/hqdefault.jpg` : '';
        activeTasksList.appendChild(taskCard({ title: prep.title, thumbnail: thumb }, [sub], []));
      }
      if (active.length === 0 && preparing.length === 0) {
        activeTasksList.appendChild(el('div', 'tasks-empty-mini', 'No active downloads'));
      } else {
        for (const task of active) {
          const recv = formatBytes(task.bytesReceived);
          const total = formatBytes(task.totalBytes);
          const sizeStr = total ? `${recv} / ${total}` : (recv || 'Streaming...');
          const pct = clampPercent(task.percent);

          const bar = el('div', 'progress-bar-bg');
          bar.style.height = '5px';
          bar.style.margin = '3px 0';
          const fill = el('div', 'progress-bar-fill');
          fill.style.width = `${Math.max(pct, 5)}%`;
          bar.appendChild(fill);

          const sub = el('div', 'task-card-sub');
          sub.append(formatChip(task.format), el('span', null, `${pct}% (${sizeStr})`));

          const cancelBtn = iconButton('action-icon-btn danger', 'Cancel Download', ICON_CANCEL, () => {
            chrome.runtime.sendMessage({ action: 'CANCEL_TASK', downloadId: task.id }, () => {
              loadTasks();
            });
          });

          activeTasksList.appendChild(taskCard(task, [bar, sub], [cancelBtn]));
        }
      }

      // 3. Render History List in Tasks Tab
      historyTasksList.replaceChildren();
      if (history.length === 0) {
        historyTasksList.appendChild(el('div', 'tasks-empty-mini', 'No downloaded videos yet'));
      } else {
        for (const task of history) {
          const isComplete = task.state === 'complete';
          const statusText = isComplete ? '✅ Complete' : `⚠️ ${task.error || 'Interrupted'}`;
          const timeStr = formatTimeAgo(task.endTime || task.startTime);

          const status = el('span', null, statusText);
          status.style.color = isComplete ? '#10b981' : '#ef4444';
          const sub = el('div', 'task-card-sub');
          sub.append(formatChip(task.format), status, el('span', null, `• ${timeStr}`));

          const actions = [];
          if (isComplete) {
            actions.push(iconButton('action-icon-btn', 'Show in Folder', ICON_FOLDER, () => {
              chrome.runtime.sendMessage({ action: 'SHOW_IN_FOLDER', downloadId: task.id });
            }));
          }
          actions.push(iconButton('action-icon-btn danger', 'Remove from list', ICON_DELETE, () => {
            chrome.runtime.sendMessage({ action: 'REMOVE_TASK', downloadId: task.id }, () => {
              loadTasks();
            });
          }));

          historyTasksList.appendChild(taskCard(task, [sub], actions));
        }
      }
    });
  }

  // ----------------- Safe DOM Builders -----------------
  // Task titles/errors come from YouTube and the server, so they are only
  // ever written with textContent, never innerHTML.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_CANCEL = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
  const ICON_FOLDER = 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z';
  const ICON_DELETE = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';
  const PLACEHOLDER_THUMB = 'https://img.youtube.com/vi/placeholder/hqdefault.jpg';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clampPercent(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
  }

  function safeThumb(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && (u.hostname === 'img.youtube.com' || u.hostname === 'i.ytimg.com')) return u.href;
    } catch (e) {
      // fall through
    }
    return PLACEHOLDER_THUMB;
  }

  function formatChip(format) {
    const fmt = String(format || '');
    const color = fmt === 'mp3' ? 'green' : (fmt === '4k' ? 'gold' : 'blue');
    const chip = el('span', `chip chip-${color}`, fmt.toUpperCase());
    chip.style.padding = '1px 4px';
    chip.style.fontSize = '9px';
    return chip;
  }

  function iconButton(className, title, pathD, onClick) {
    const btn = el('button', className);
    btn.title = title;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function taskCard(task, infoChildren, actionButtons) {
    const card = el('div', 'task-card');

    const img = el('img', 'task-card-thumb');
    img.src = safeThumb(task.thumbnail);
    img.alt = '';

    const info = el('div', 'task-card-info');
    const title = el('div', 'task-card-title', String(task.title || ''));
    title.title = String(task.title || '');
    info.append(title, ...infoChildren);

    const actions = el('div', 'task-card-actions');
    actions.append(...actionButtons);

    card.append(img, info, actions);
    return card;
  }

  // ----------------- Quick Utilities -----------------
  function downloadThumbnail() {
    if (!currentVideoId) return;
    const thumbUrl = `https://img.youtube.com/vi/${currentVideoId}/maxresdefault.jpg`;
    chrome.runtime.sendMessage({
      action: 'DOWNLOAD_DIRECT',
      url: thumbUrl,
      filename: `${currentVideoTitle} - HD Thumbnail`,
      ext: 'jpg'
    }, () => {
      if (chrome.runtime.lastError) {
        showStatus('Thumbnail download failed.', 'error');
      } else {
        showStatus('HD Thumbnail downloaded!', 'success');
      }
    });
  }

  function openDownloadsFolder() {
    chrome.runtime.sendMessage({ action: 'OPEN_FOLDER' }, (res) => {
      if (chrome.runtime.lastError || (res && !res.success)) {
        showStatus('Downloads folder opened in browser.', 'info');
      } else {
        showStatus('Opening Downloads folder...', 'info');
      }
    });
  }

  function copyYtDlpCmd() {
    if (!currentVideoId) return;
    const url = `https://www.youtube.com/watch?v=${currentVideoId}`;
    const cmd = `yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" --merge-output-format mp4 "${url}"`;
    navigator.clipboard.writeText(cmd).then(() => {
      showStatus('yt-dlp command copied!', 'success');
    });
  }
});
