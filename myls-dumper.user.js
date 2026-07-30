// ==UserScript==
// @name         MyLS Content Dumper
// @namespace    myls-dumper
// @version      1.0
// @description  Recursively walks a Brightspace/D2L Content module tree and downloads every file-backed topic into one zip
// @match        *://*/d2l/le/content/*/Home*
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const orgMatch = location.pathname.match(/\/d2l\/le\/content\/(\d+)\//);
  const ORG = orgMatch[1];

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const logLines = [];

  function log(...args) {
    console.log(...args);
    logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }

  function saveLog() {
    const blob = new Blob([logLines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `myls-dumper-log-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function collectModules(ul, pathParts, out) {
    for (const li of ul.children) {
      if (li.tagName !== 'LI') continue;
      const dataKey = li.getAttribute('data-key') || '';
      const idMatch = dataKey.match(/ModuleCO-(\d+)$/);
      if (!idMatch) continue;

      const moduleId = idMatch[1];
      const titleEl = li.querySelector(`#TreeItem${moduleId} > .d2l-textblock:not(.d2l-offscreen)`);
      const title = titleEl ? titleEl.textContent.trim() : moduleId;
      const path = [...pathParts, sanitize(title)];

      out.push({ moduleId, path });

      const childUl = li.querySelector(':scope > ul.d2l-le-TreeAccordionGroup');
      if (childUl) collectModules(childUl, path, out);
    }
  }

  function findHtmlPayload(obj, seen) {
    seen = seen || new Set();
    if (typeof obj === 'string') {
      return obj.includes('d2l-datalist-item') || obj.includes('/viewContent/') ? obj : null;
    }
    if (obj && typeof obj === 'object') {
      if (seen.has(obj)) return null;
      seen.add(obj);
      for (const key of Object.keys(obj)) {
        const found = findHtmlPayload(obj[key], seen);
        if (found) return found;
      }
    }
    return null;
  }

  async function fetchTopics(moduleId) {
    const res = await fetch(`/d2l/le/content/${ORG}/ModuleDetailsPartial?mId=${moduleId}&writeHistoryEntry=0`, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) {
      log(`[myls-dumper] module ${moduleId}: ModuleDetailsPartial returned ${res.status}, skipping`);
      return [];
    }

    const raw = await res.text();
    let html = raw;
    if (raw.startsWith('while(1);')) {
      try {
        const parsed = JSON.parse(raw.slice('while(1);'.length));
        html = findHtmlPayload(parsed) || '';
      } catch (err) {
        log(`[myls-dumper] module ${moduleId}: failed to parse JSON envelope (${err})`);
        return [];
      }
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');

    const topics = [];
    doc.querySelectorAll('a.d2l-link[href*="/viewContent/"]').forEach((a) => {
      const m = a.getAttribute('href').match(/viewContent\/(\d+)\/View/);
      if (m) topics.push({ topicId: m[1], title: a.textContent.trim() });
    });

    const loadMore = doc.querySelector('.d2l-loadmore-pager:not(.d2l-hidden)');
    if (loadMore) {
      log(`[myls-dumper] module ${moduleId} has a "Load More" pager; some topics may be missing`);
    }

    return topics;
  }

  async function downloadTopic(topicId, path, title, stats, zip) {
    let info;
    try {
      const infoRes = await fetch(
        `/d2l/le/content/${ORG}/topics/files/download/${topicId}/CheckFileTopicInfo`,
        { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } }
      );
      if (!infoRes.ok) throw new Error(`status ${infoRes.status}`);
      const text = await infoRes.text();
      const jsonText = text.startsWith('while(1);') ? text.slice('while(1);'.length) : text;
      info = JSON.parse(jsonText);
    } catch (err) {
      stats.notFileBacked++;
      return;
    }

    if (info.IsBroken) {
      stats.broken++;
      return;
    }
    if (info.IsPackageable) {
      stats.packaged++;
      return;
    }

    const fileRes = await fetch(
      `/d2l/le/content/${ORG}/topics/files/download/${topicId}/DirectFileTopicDownload`,
      { credentials: 'same-origin' }
    );
    const blob = await fileRes.blob();

    const disposition = fileRes.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/);
    const filename = match ? decodeURIComponent(match[1]) : sanitize(title);

    const zipPath = `${path.join('/')}/${filename}`;
    zip.file(zipPath, blob);

    stats.downloaded++;
    log(`[myls-dumper] added to zip: ${zipPath}`);
  }

  async function saveZip(zip) {
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `myls-dump-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  let stopped = false;
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    stopped = false;
    dumpBtn.disabled = true;
    stopBtn.disabled = false;
    updateProgress(0, 0);

    const stats = { downloaded: 0, notFileBacked: 0, broken: 0, packaged: 0 };
    const zip = new JSZip();

    try {
      const tree = document.getElementById('D2L_LE_Content_TreeBrowser');
      if (!tree) {
        log('[myls-dumper] content tree not found on this page');
        return;
      }

      const modules = [];
      collectModules(tree, [], modules);
      log(`[myls-dumper] found ${modules.length} modules`);

      for (const mod of modules) {
        if (stopped) break;
        log(`[myls-dumper] scanning: ${mod.path.join(' > ')}`);
        mod.topics = await fetchTopics(mod.moduleId);
        await sleep(300);
      }
      if (stopped) return;

      const deepestFirst = [...modules].sort((a, b) => b.path.length - a.path.length);
      const claimed = new Set();
      const toDownload = [];

      for (const mod of deepestFirst) {
        const owned = mod.topics.filter((t) => !claimed.has(t.topicId));
        owned.forEach((t) => claimed.add(t.topicId));
        if (owned.length < mod.topics.length) {
          log(`[myls-dumper] ${mod.path.join(' > ')}: ${mod.topics.length - owned.length} topics already claimed by a descendant, ${owned.length} to download`);
        }
        owned.forEach((t) => toDownload.push({ ...t, path: mod.path }));
      }

      log(`[myls-dumper] ${toDownload.length} topics to process`);
      updateProgress(0, toDownload.length);

      for (let i = 0; i < toDownload.length; i++) {
        if (stopped) break;
        const topic = toDownload[i];
        await downloadTopic(topic.topicId, topic.path, topic.title, stats, zip);
        updateProgress(i + 1, toDownload.length);
        await sleep(300);
      }
    } finally {
      running = false;
      dumpBtn.disabled = false;
      stopBtn.disabled = true;
      log(
        `[myls-dumper] ${stopped ? 'stopped' : 'done'} — downloaded: ${stats.downloaded}, ` +
          `not file-backed: ${stats.notFileBacked}, broken: ${stats.broken}, packaged (skipped): ${stats.packaged}`
      );
      if (stats.downloaded > 0) {
        log('[myls-dumper] building zip...');
        await saveZip(zip);
      }
      saveLog();
    }
  }

  function stop() {
    if (!running) return;
    stopped = true;
    log('[myls-dumper] stopping after current download...');
  }

  function updateProgress(current, total) {
    if (total === 0) {
      progressWrap.style.display = 'none';
      return;
    }
    progressWrap.style.display = 'block';
    const pct = Math.round((current / total) * 100);
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = `${current} / ${total} (${pct}%)`;
  }

  window.dumpMyLS = run;
  window.stopMyLSDump = stop;
  window.saveMyLSDumpLog = saveLog;

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;' +
    'align-items:flex-end;gap:8px;font-family:sans-serif;';
  document.body.appendChild(panel);

  const progressWrap = document.createElement('div');
  progressWrap.style.cssText =
    'display:none;width:240px;height:18px;background:#ddd;border-radius:4px;overflow:hidden;' +
    'position:relative;';
  panel.appendChild(progressWrap);

  const progressFill = document.createElement('div');
  progressFill.style.cssText = 'height:100%;width:0%;background:#4caf50;transition:width 0.2s;';
  progressWrap.appendChild(progressFill);

  const progressLabel = document.createElement('div');
  progressLabel.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'font-size:11px;color:#000;';
  progressWrap.appendChild(progressLabel);

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display:flex;gap:8px;';
  panel.appendChild(buttonRow);

  const dumpBtn = document.createElement('button');
  dumpBtn.textContent = 'Dump Course Content';
  dumpBtn.style.cssText = 'padding:10px 16px;';
  dumpBtn.onclick = run;
  buttonRow.appendChild(dumpBtn);

  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'Stop';
  stopBtn.disabled = true;
  stopBtn.style.cssText = 'padding:10px 16px;';
  stopBtn.onclick = stop;
  buttonRow.appendChild(stopBtn);

  const saveLogBtn = document.createElement('button');
  saveLogBtn.textContent = 'Save Log';
  saveLogBtn.style.cssText = 'padding:10px 16px;';
  saveLogBtn.onclick = saveLog;
  buttonRow.appendChild(saveLogBtn);
})();
