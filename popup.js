const HISTORY_MAX = 100000;
const SUGGEST_TOP_N = 30;
const NEW_BOOKMARK_GRACE_DAYS = 7;

// ── Init ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.getElementById('btn-sort').addEventListener('click', onSort);
  document.getElementById('btn-discover').addEventListener('click', onDiscover);
  document.getElementById('btn-cleanup').addEventListener('click', onCleanup);
});

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${id}"]`).classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${id}`).classList.add('active');
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
    const tree = await chrome.bookmarks.getTree();
    const historyMap = await buildHistoryMap(0);
    let totalSorted = 0;
    let totalFolders = 0;

    for (const root of tree[0].children) {
      const r = await sortTree(root, historyMap);
      totalSorted += r.bookmarks;
      totalFolders += r.folders;
    }

    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <div class="result-summary">
        <div class="big-number">${totalSorted}</div>
        <div class="summary-text">个书签已在 ${totalFolders} 个文件夹中完成排序</div>
      </div>`;
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

  // Sort subfolders first
  for (const child of node.children) {
    if (!child.url) {
      const r = await sortTree(child, historyMap);
      bookmarks += r.bookmarks;
      folders += r.folders;
    }
  }

  // Re-fetch after subfolder mutations
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

// ── Tab 2: Discover ──────────────────────────────────────

async function onDiscover() {
  const tab = 'discover';
  setLoading(tab, true);
  const resultEl = document.getElementById('discover-result');
  resultEl.classList.add('hidden');

  try {
    const days = +document.querySelector('input[name="discoverPeriod"]:checked').value;
    const startTime = Date.now() - days * 86400000;

    const [historyItems, bookmarkUrls] = await Promise.all([
      chrome.history.search({ text: '', maxResults: HISTORY_MAX, startTime }),
      getAllBookmarkUrls()
    ]);

    const candidates = historyItems
      .filter(h => !bookmarkUrls.has(h.url) && !isInternal(h.url))
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
}

// ── Tab 3: Cleanup ───────────────────────────────────────

async function onCleanup() {
  const tab = 'cleanup';
  setLoading(tab, true);
  const resultEl = document.getElementById('cleanup-result');
  resultEl.classList.add('hidden');

  try {
    const days = +document.querySelector('input[name="cleanupPeriod"]:checked').value;
    const tree = await chrome.bookmarks.getTree();
    const allBms = flattenBookmarks(tree);

    // Exclude recently created bookmarks
    const graceCutoff = Date.now() - NEW_BOOKMARK_GRACE_DAYS * 86400000;
    const eligible = allBms.filter(b => b.dateAdded < graceCutoff && !isInternal(b.url));

    const historyMap = await buildHistoryMap(0);
    const cutoff = days > 0 ? Date.now() - days * 86400000 : null;

    const unused = eligible.filter(b => {
      const h = historyMap[b.url];
      if (!h) return true; // never visited
      if (cutoff && h.lastVisitTime >= cutoff) return false; // visited recently
      if (days === 0) return false; // "never visited" mode: in history = visited
      return h.lastVisitTime < cutoff;
    });

    // Sort: never visited first, then by oldest visit
    unused.sort((a, b) => {
      const ha = historyMap[a.url];
      const hb = historyMap[b.url];
      const va = ha ? ha.lastVisitTime : 0;
      const vb = hb ? hb.lastVisitTime : 0;
      return va - vb;
    });

    resultEl.classList.remove('hidden');

    if (unused.length === 0) {
      resultEl.innerHTML = '<div class="result-empty">没有找到无用书签，你的收藏夹维护得很好！</div>';
      return;
    }

    resultEl.innerHTML = renderUrlList(unused, {
      header: `找到 ${unused.length} 个无用书签`,
      type: 'cleanup',
      historyMap
    });

    bindCleanupActions(unused);
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
    return `<button class="btn-small btn-add" data-idx="${i}">+ 收藏</button>`;
  }
  if (opts.type === 'cleanup') {
    return `<button class="btn-small btn-danger btn-remove" data-idx="${i}">移除</button>`;
  }
  return '';
}
