const HISTORY_MAX = 100000;
const SUGGEST_TOP_N = 30;
const BACKUP_KEY = 'sortBackup';

// ── Ignore list helpers ───────────────────────────────────

async function loadIgnoreList(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] || [];
}

async function saveIgnoreList(key, list) {
  await chrome.storage.local.set({ [key]: list });
}

async function getIgnoredUrls(key) {
  const list = await loadIgnoreList(key);
  return new Set(list.map(e => e.url));
}

async function addIgnore(key, url, title) {
  const list = await loadIgnoreList(key);
  if (!list.some(e => e.url === url)) {
    list.push({ url, title, dateAdded: Date.now() });
    await saveIgnoreList(key, list);
  }
}

async function removeIgnore(key, url) {
  const list = await loadIgnoreList(key);
  await saveIgnoreList(key, list.filter(e => e.url !== url));
}

// ── Init ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.getElementById('btn-sort').addEventListener('click', onSort);
  document.getElementById('btn-discover').addEventListener('click', onDiscover);
  document.getElementById('btn-cleanup').addEventListener('click', onCleanup);
  document.getElementById('btn-settings').addEventListener('click', showSettings);
  document.getElementById('btn-back').addEventListener('click', hideSettings);
});

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${id}"]`).classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${id}`).classList.add('active');
}

function showSettings() {
  document.getElementById('main-view').classList.add('hidden');
  document.getElementById('settings-view').classList.remove('hidden');
  renderSettings();
}

function hideSettings() {
  document.getElementById('settings-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
}

// ── Helpers ───────────────────────────────────────────────

function setLoading(tab, on) {
  const btn = document.getElementById(`btn-${tab}`);
  btn.disabled = on;
  btn.querySelector('.btn-text').classList.toggle('hidden', on);
  btn.querySelector('.btn-loader').classList.toggle('hidden', !on);
}

function showError(tab, msg) {
  const el = document.getElementById(`${tab}-result`);
  el.classList.remove('hidden');
  el.innerHTML = `<div class="error-banner">${esc(msg)}</div>`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function isInternal(url) {
  return /^(chrome|chrome-extension|about|edge|brave|javascript|data):/.test(url);
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function favicon(url) {
  return `https://www.google.com/s2/favicons?domain=${hostname(url)}&sz=32`;
}

function daysAgo(ms) {
  if (!ms) return '从未';
  const d = Math.round((Date.now() - ms) / 86400000);
  if (d === 0) return '今天';
  if (d === 1) return '1 天前';
  return `${d} 天前`;
}

// ── History map ──────────────────────────────────────────

async function buildHistoryMap(startTime = 0) {
  const items = await chrome.history.search({ text: '', maxResults: HISTORY_MAX, startTime });
  const map = {};
  for (const h of items) {
    map[h.url] = { visitCount: h.visitCount, lastVisitTime: h.lastVisitTime };
  }
  return map;
}

// ── Bookmark utilities ───────────────────────────────────

async function getAllBookmarkUrls() {
  const tree = await chrome.bookmarks.getTree();
  const urls = new Set();
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.url) urls.add(n.url);
      if (n.children) walk(n.children);
    }
  })(tree);
  return urls;
}

function flattenBookmarks(nodes) {
  const list = [];
  (function walk(nodes, parentTitle) {
    for (const n of nodes) {
      if (n.url) list.push({ ...n, _folder: parentTitle });
      if (n.children) walk(n.children, n.title);
    }
  })(nodes, '');
  return list;
}

// ── Tab 1: Sort ──────────────────────────────────────────

async function onSort() {
  const tab = 'sort';
  setLoading(tab, true);
  const resultEl = document.getElementById('sort-result');
  resultEl.classList.add('hidden');

  try {
    // 1. 备份当前书签位置
    await saveBackup();

    // 2. 执行排序
    const tree = await chrome.bookmarks.getTree();
    const historyMap = await buildHistoryMap(0);
    let totalSorted = 0;
    let totalFolders = 0;

    for (const root of tree[0].children) {
      const r = await sortTree(root, historyMap);
      totalSorted += r.bookmarks;
      totalFolders += r.folders;
    }

    // 3. 显示结果 + 撤销按钮
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <div class="result-summary">
        <div class="big-number">${totalSorted}</div>
        <div class="summary-text">个书签已在 ${totalFolders} 个文件夹中完成排序</div>
        <div class="undo-bar">
          <button id="btn-undo-sort" class="btn btn-secondary">↩ 撤销排序</button>
        </div>
      </div>`;

    document.getElementById('btn-undo-sort').addEventListener('click', async () => {
      const undoBtn = document.getElementById('btn-undo-sort');
      undoBtn.disabled = true;
      undoBtn.textContent = '正在撤销…';
      try {
        await restoreFromBackup();
        undoBtn.textContent = '✅ 已撤销';
        // 刷新结果区显示恢复完成
        document.querySelector('.result-summary .summary-text').textContent =
          '个书签已恢复到排序前的位置';
      } catch (err) {
        undoBtn.textContent = `撤销失败：${err.message}`;
      }
    });
  } catch (err) {
    showError(tab, `排序失败：${err.message}`);
  } finally {
    setLoading(tab, false);
  }
}

async function sortTree(node, historyMap) {
  let bookmarks = 0;
  let folders = 0;

  if (!node.children || node.children.length === 0) return { bookmarks, folders };

  for (const child of node.children) {
    if (!child.url) {
      const r = await sortTree(child, historyMap);
      bookmarks += r.bookmarks;
      folders += r.folders;
    }
  }

  const [fresh] = await chrome.bookmarks.getSubTree(node.id);
  const kids = fresh.children;

  const dirs = kids.filter(c => !c.url);
  const bms = kids.filter(c => c.url);

  if (bms.length > 1) {
    bms.sort((a, b) => (historyMap[b.url]?.visitCount || 0) - (historyMap[a.url]?.visitCount || 0));
    const ordered = [...bms, ...dirs];
    for (let i = 0; i < ordered.length; i++) {
      await chrome.bookmarks.move(ordered[i].id, { index: i });
    }
    bookmarks += bms.length;
  }

  folders += 1;
  return { bookmarks, folders };
}

// ── Backup / Undo ─────────────────────────────────────────

async function saveBackup() {
  const tree = await chrome.bookmarks.getTree();
  const snapshot = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.url) {
        snapshot.push({ id: n.id, parentId: n.parentId, index: n.index });
      }
      if (n.children) walk(n.children);
    }
  })(tree);
  await chrome.storage.local.set({
    [BACKUP_KEY]: { timestamp: Date.now(), snapshot }
  });
}

async function loadBackup() {
  const data = await chrome.storage.local.get(BACKUP_KEY);
  return data[BACKUP_KEY] || null;
}

async function restoreFromBackup() {
  const backup = await loadBackup();
  if (!backup || !backup.snapshot.length) {
    throw new Error('没有找到备份数据');
  }

  // 按 (parentId, index) 升序恢复，保证索引正确
  const sorted = [...backup.snapshot].sort((a, b) => {
    if (a.parentId !== b.parentId) return a.parentId.localeCompare(b.parentId);
    return a.index - b.index;
  });

  for (const item of sorted) {
    try {
      await chrome.bookmarks.move(item.id, { parentId: item.parentId, index: item.index });
    } catch {
      // 书签可能已被删除，跳过
    }
  }
}

// ── Tab 2: Discover ──────────────────────────────────────

const IGNORE_KEY_DISCOVER = 'discoverIgnore';

async function onDiscover() {
  const tab = 'discover';
  setLoading(tab, true);
  const resultEl = document.getElementById('discover-result');
  resultEl.classList.add('hidden');

  try {
    const days = +document.querySelector('input[name="discoverPeriod"]:checked').value;
    const startTime = Date.now() - days * 86400000;

    const [historyItems, bookmarkUrls, ignoredUrls] = await Promise.all([
      chrome.history.search({ text: '', maxResults: HISTORY_MAX, startTime }),
      getAllBookmarkUrls(),
      getIgnoredUrls(IGNORE_KEY_DISCOVER)
    ]);

    const candidates = historyItems
      .filter(h => !bookmarkUrls.has(h.url) && !isInternal(h.url) && !ignoredUrls.has(h.url))
      .sort((a, b) => b.visitCount - a.visitCount)
      .slice(0, SUGGEST_TOP_N);

    resultEl.classList.remove('hidden');

    if (candidates.length === 0) {
      resultEl.innerHTML = '<div class="result-empty">所有高频访问的网站都已经在收藏夹中了！</div>';
      return;
    }

    resultEl.innerHTML = renderUrlList(candidates, {
      header: `发现 ${candidates.length} 个网站（最近 ${days} 天）`,
      type: 'discover'
    });

    bindDiscoverActions(candidates);
  } catch (err) {
    showError(tab, `分析失败：${err.message}`);
  } finally {
    setLoading(tab, false);
  }
}

function bindDiscoverActions(items) {
  document.querySelectorAll('.btn-add').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      const item = items[i];
      btn.disabled = true;
      btn.textContent = '已添加';
      try {
        await chrome.bookmarks.create({ title: item.title || item.url, url: item.url });
      } catch {
        btn.textContent = '添加失败';
      }
    });
  });
  bindIgnoreButtons(items, IGNORE_KEY_DISCOVER);
}

// ── Tab 3: Cleanup ───────────────────────────────────────

const IGNORE_KEY_CLEANUP = 'cleanupIgnore';

async function onCleanup() {
  const tab = 'cleanup';
  setLoading(tab, true);
  const resultEl = document.getElementById('cleanup-result');
  resultEl.classList.add('hidden');

  try {
    const days = +document.querySelector('input[name="cleanupPeriod"]:checked').value;
    const startTime = Date.now() - days * 86400000;

    const [tree, ignoredUrls] = await Promise.all([
      chrome.bookmarks.getTree(),
      getIgnoredUrls(IGNORE_KEY_CLEANUP)
    ]);
    const allBms = flattenBookmarks(tree).filter(b => !isInternal(b.url) && !ignoredUrls.has(b.url));

    const historyMap = await buildHistoryMap(startTime);

    const ranked = allBms.map(b => ({
      ...b,
      _visits: historyMap[b.url]?.visitCount || 0,
      _lastVisit: historyMap[b.url]?.lastVisitTime || null
    }));

    ranked.sort((a, b) => {
      if (a._visits !== b._visits) return a._visits - b._visits;
      return (a._lastVisit || 0) - (b._lastVisit || 0);
    });

    resultEl.classList.remove('hidden');

    if (ranked.length === 0) {
      resultEl.innerHTML = '<div class="result-empty">收藏夹中没有书签。</div>';
      return;
    }

    resultEl.innerHTML = renderUrlList(ranked, {
      header: `${ranked.length} 个书签，按最近 ${days} 天访问频次从低到高排列`,
      type: 'cleanup',
      historyMap
    });

    bindCleanupActions(ranked);
  } catch (err) {
    showError(tab, `扫描失败：${err.message}`);
  } finally {
    setLoading(tab, false);
  }
}

function bindCleanupActions(items) {
  document.querySelectorAll('.btn-remove').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      const item = items[i];
      btn.disabled = true;
      btn.textContent = '已移除';
      try {
        await chrome.bookmarks.remove(item.id);
        const row = btn.closest('.result-item');
        row.style.opacity = '0.4';
      } catch {
        btn.textContent = '移除失败';
      }
    });
  });
  bindIgnoreButtons(items, IGNORE_KEY_CLEANUP);
}

// ── Ignore button binding ───────────────────────────────

function bindIgnoreButtons(items, key) {
  document.querySelectorAll('.btn-ignore-action').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      const item = items[i];
      await addIgnore(key, item.url, item.title || item.url);
      const row = btn.closest('.result-item');
      row.style.opacity = '0.3';
      row.style.pointerEvents = 'none';
      btn.textContent = '已忽略';
    });
  });
}

// ── Settings view ────────────────────────────────────────

async function renderSettings() {
  await Promise.all([
    renderIgnoreSection(IGNORE_KEY_DISCOVER, 'ignore-discover-list', '发现'),
    renderIgnoreSection(IGNORE_KEY_CLEANUP, 'ignore-cleanup-list', '清理')
  ]);
}

async function renderIgnoreSection(key, containerId, label) {
  const container = document.getElementById(containerId);
  const list = await loadIgnoreList(key);

  if (list.length === 0) {
    container.innerHTML = '<div class="result-empty">暂无忽略的网站</div>';
    return;
  }

  const rows = list.map(item => `
    <div class="result-item">
      <img class="favicon" src="${favicon(item.url)}" alt="" onerror="this.style.display='none'">
      <div class="info">
        <div class="site-title" title="${esc(item.title || item.url)}">${esc(item.title || item.url)}</div>
        <div class="site-url" title="${esc(item.url)}">${esc(item.url)}</div>
        <div class="site-meta">${daysAgo(item.dateAdded)} 添加</div>
      </div>
      <div class="actions">
        <button class="btn-small btn-unignore" data-key="${esc(key)}" data-url="${esc(item.url)}">取消忽略</button>
      </div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="result">
      <div class="result-header">${label} — ${list.length} 个</div>
      <div class="result-list">${rows}</div>
    </div>`;

  container.querySelectorAll('.btn-unignore').forEach(btn => {
    btn.addEventListener('click', async () => {
      await removeIgnore(btn.dataset.key, btn.dataset.url);
      renderIgnoreSection(btn.dataset.key, containerId, label);
    });
  });
}

// ── Rendering ────────────────────────────────────────────

function renderUrlList(items, opts) {
  const rows = items.map((item, i) => {
    const meta = itemMeta(item, opts);
    const actions = itemActions(item, opts, i);
    return `
      <div class="result-item">
        <img class="favicon" src="${favicon(item.url)}" alt="" onerror="this.style.display='none'">
        <div class="info">
          <div class="site-title" title="${esc(item.title || item.url)}">${esc(item.title || item.url)}</div>
          <div class="site-url" title="${esc(item.url)}">${esc(item.url)}</div>
          <div class="site-meta">${meta}</div>
        </div>
        <div class="actions">${actions}</div>
      </div>`;
  }).join('');

  return `
    <div class="result-header">${esc(opts.header)}</div>
    <div class="result-list">${rows}</div>`;
}

function itemMeta(item, opts) {
  if (opts.type === 'discover') {
    return `访问 <span class="count">${item.visitCount}</span> 次`;
  }
  if (opts.type === 'cleanup') {
    const h = opts.historyMap[item.url];
    if (!h) return '从未访问过';
    return `上次访问：<span class="count">${daysAgo(h.lastVisitTime)}</span> &middot; 共 ${h.visitCount} 次`;
  }
  return '';
}

function itemActions(item, opts, i) {
  if (opts.type === 'discover') {
    return `<button class="btn-small btn-add">+ 收藏</button>
            <button class="btn-small btn-ignore btn-ignore-action">忽略</button>`;
  }
  if (opts.type === 'cleanup') {
    return `<button class="btn-small btn-ignore btn-ignore-action">忽略</button>
            <button class="btn-small btn-danger btn-remove">移除</button>`;
  }
  return '';
}
