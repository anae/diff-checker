const els = {
  leftText: document.querySelector('#leftText'),
  rightText: document.querySelector('#rightText'),
  leftLines: document.querySelector('#leftLines'),
  rightLines: document.querySelector('#rightLines'),
  leftHighlights: document.querySelector('#leftHighlights'),
  rightHighlights: document.querySelector('#rightHighlights'),
  leftStats: document.querySelector('#leftStats'),
  rightStats: document.querySelector('#rightStats'),
  leftFilename: document.querySelector('#leftFilename'),
  rightFilename: document.querySelector('#rightFilename'),
  leftFile: document.querySelector('#leftFile'),
  rightFile: document.querySelector('#rightFile'),
  diffCount: document.querySelector('#diffCount'),
  diffPosition: document.querySelector('#diffPosition'),
  previousDiff: document.querySelector('#previousDiff'),
  nextDiff: document.querySelector('#nextDiff'),
  comparisonMode: document.querySelector('#comparisonMode'),
  swapTexts: document.querySelector('#swapTexts'),
  clearTexts: document.querySelector('#clearTexts'),
  downloadLeft: document.querySelector('#downloadLeft'),
  downloadRight: document.querySelector('#downloadRight'),
  mergeRail: document.querySelector('#mergeRail'),
  minimap: document.querySelector('#minimap'),
  minimapTrack: document.querySelector('#minimapTrack'),
  minimapViewport: document.querySelector('#minimapViewport'),
  toast: document.querySelector('#toast'),
  summary: document.querySelector('.diff-summary'),
};

const LINE_HEIGHT = 24;
const EDITOR_PADDING = 18;
const MAX_LCS_CELLS = 4_000_000;

const sampleLeft = `Projet : Atlas\nStatut : En préparation\nResponsable : Elliot\n\nObjectifs\n- Clarifier le périmètre\n- Valider les dépendances\n- Livrer la version pilote en novembre\n\nBudget estimé : 125 000 EUR\nRisque principal : disponibilité des données\n\nProchaine étape : atelier de cadrage`;
const sampleRight = `Projet : Atlas\nStatut : En cours\nResponsable : Elliot Ananaba\n\nObjectifs\n- Clarifier le périmètre\n- Valider les dépendances critiques\n- Documenter les décisions\n- Livrer la version pilote en décembre\n\nBudget estimé : 140 000 EUR\nRisque principal : qualité des données\n\nProchaine étape : atelier de cadrage`;

let hunks = [];
let currentHunk = -1;
let compareTimer = null;
let toastTimer = null;
let syncingScroll = false;

function splitLines(value) {
  return value.replace(/\r\n?/g, '\n').split('\n');
}

function comparable(line) {
  return els.comparisonMode.value === 'trim' ? line.replace(/[ \t]+$/g, '') : line;
}

function buildDiff(leftLines, rightLines) {
  const n = leftLines.length;
  const m = rightLines.length;

  if (n * m > MAX_LCS_CELLS) {
    let prefix = 0;
    while (prefix < n && prefix < m && comparable(leftLines[prefix]) === comparable(rightLines[prefix])) prefix += 1;
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && comparable(leftLines[n - 1 - suffix]) === comparable(rightLines[m - 1 - suffix])) suffix += 1;
    const ops = [];
    for (let i = 0; i < prefix; i += 1) ops.push({ type: 'equal', left: i, right: i });
    for (let i = prefix; i < n - suffix; i += 1) ops.push({ type: 'remove', left: i });
    for (let j = prefix; j < m - suffix; j += 1) ops.push({ type: 'add', right: j });
    for (let i = 0; i < suffix; i += 1) ops.push({ type: 'equal', left: n - suffix + i, right: m - suffix + i });
    return ops;
  }

  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      rows[i][j] = comparable(leftLines[i]) === comparable(rightLines[j])
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (comparable(leftLines[i]) === comparable(rightLines[j])) {
      ops.push({ type: 'equal', left: i, right: j });
      i += 1;
      j += 1;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      ops.push({ type: 'remove', left: i });
      i += 1;
    } else {
      ops.push({ type: 'add', right: j });
      j += 1;
    }
  }
  while (i < n) { ops.push({ type: 'remove', left: i }); i += 1; }
  while (j < m) { ops.push({ type: 'add', right: j }); j += 1; }
  return ops;
}

function groupHunks(ops) {
  const result = [];
  let active = null;
  let leftCursor = 0;
  let rightCursor = 0;

  ops.forEach((op) => {
    if (op.type === 'equal') {
      if (active) { result.push(active); active = null; }
      leftCursor = op.left + 1;
      rightCursor = op.right + 1;
      return;
    }
    if (!active) {
      active = { leftIndices: [], rightIndices: [], leftStart: leftCursor, rightStart: rightCursor };
    }
    if (op.left !== undefined) {
      active.leftIndices.push(op.left);
      leftCursor = op.left + 1;
    }
    if (op.right !== undefined) {
      active.rightIndices.push(op.right);
      rightCursor = op.right + 1;
    }
  });
  if (active) result.push(active);

  return result.map((hunk) => ({
      ...hunk,
      leftEnd: hunk.leftIndices.length ? hunk.leftIndices.at(-1) + 1 : hunk.leftStart,
      rightEnd: hunk.rightIndices.length ? hunk.rightIndices.at(-1) + 1 : hunk.rightStart,
      type: hunk.leftIndices.length && hunk.rightIndices.length ? 'change' : hunk.leftIndices.length ? 'remove' : 'add',
    }));
}

function compareNow({ preserveSelection = false } = {}) {
  clearTimeout(compareTimer);
  const left = splitLines(els.leftText.value);
  const right = splitLines(els.rightText.value);
  hunks = groupHunks(buildDiff(left, right));

  if (!preserveSelection || currentHunk >= hunks.length) currentHunk = hunks.length ? 0 : -1;

  updateStats(left, right);
  renderLineNumbers(left.length, right.length);
  renderHighlights();
  renderSummary();
  renderMergeRail();
  renderMinimap();
}

function scheduleCompare() {
  clearTimeout(compareTimer);
  compareTimer = setTimeout(() => compareNow(), 90);
}

function updateStats(left, right) {
  const format = (lines, text) => `${lines.length.toLocaleString('fr-BE')} ligne${lines.length > 1 ? 's' : ''} · ${text.length.toLocaleString('fr-BE')} caractère${text.length > 1 ? 's' : ''}`;
  els.leftStats.textContent = format(left, els.leftText.value);
  els.rightStats.textContent = format(right, els.rightText.value);
}

function changedSets(side) {
  const changed = new Set();
  hunks.forEach((hunk) => {
    const indices = side === 'left' ? hunk.leftIndices : hunk.rightIndices;
    indices.forEach((index) => changed.add(index));
  });
  return changed;
}

function renderLineNumbers(leftCount, rightCount) {
  const render = (count, target, side) => {
    const changed = changedSets(side);
    const active = currentHunk >= 0 ? new Set(side === 'left' ? hunks[currentHunk].leftIndices : hunks[currentHunk].rightIndices) : new Set();
    target.innerHTML = Array.from({ length: count }, (_, index) => {
      const classes = [changed.has(index) ? 'changed' : '', active.has(index) ? 'current' : ''].filter(Boolean).join(' ');
      return `<span class="${classes}">${index + 1}</span>`;
    }).join('');
  };
  render(leftCount, els.leftLines, 'left');
  render(rightCount, els.rightLines, 'right');
  syncDecorations('left');
  syncDecorations('right');
}

function renderHighlights() {
  const render = (side, target) => {
    const blocks = [];
    hunks.forEach((hunk, hunkIndex) => {
      const indices = side === 'left' ? hunk.leftIndices : hunk.rightIndices;
      const addition = (side === 'right' && hunk.type === 'add') || (side === 'left' && hunk.type === 'remove');
      indices.forEach((line) => {
        blocks.push(`<span class="highlight-line ${addition ? 'addition' : ''} ${hunkIndex === currentHunk ? 'current' : ''}" data-line="${line}" style="top:${EDITOR_PADDING + line * LINE_HEIGHT}px"></span>`);
      });
    });
    target.innerHTML = blocks.join('');
  };
  render('left', els.leftHighlights);
  render('right', els.rightHighlights);
  syncDecorations('left');
  syncDecorations('right');
}

function renderSummary() {
  const count = hunks.length;
  els.diffCount.textContent = `${count} différence${count > 1 ? 's' : ''}`;
  els.diffPosition.textContent = count ? `Écart ${currentHunk + 1} sur ${count}` : 'Les textes sont identiques';
  els.summary.classList.toggle('has-diffs', count > 0);
  els.previousDiff.disabled = count === 0;
  els.nextDiff.disabled = count === 0;
}

function renderMergeRail() {
  if (!hunks.length) { els.mergeRail.innerHTML = ''; return; }
  const leftScroll = els.leftText.scrollTop;
  const rightScroll = els.rightText.scrollTop;
  const headerOffset = document.querySelector('.editor-panel[data-side="left"] .panel-header').offsetHeight;
  const editorHeight = document.querySelector('#leftEditor').clientHeight;
  els.mergeRail.innerHTML = hunks.map((hunk, index) => {
    const leftMiddle = EDITOR_PADDING + ((hunk.leftStart + Math.max(1, hunk.leftEnd - hunk.leftStart) / 2) * LINE_HEIGHT) - leftScroll;
    const rightMiddle = EDITOR_PADDING + ((hunk.rightStart + Math.max(1, hunk.rightEnd - hunk.rightStart) / 2) * LINE_HEIGHT) - rightScroll;
    const rawTop = headerOffset + (leftMiddle + rightMiddle) / 2;
    const top = Math.max(headerOffset + 18, Math.min(headerOffset + editorHeight - 18, rawTop));
    const visible = rawTop > headerOffset && rawTop < headerOffset + editorHeight;
    return `<div class="merge-action" style="top:${top}px;${visible ? '' : 'display:none'}" data-index="${index}">
      <button type="button" data-direction="right-to-left" title="Appliquer la droite à gauche" aria-label="Appliquer la différence ${index + 1} de droite à gauche"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 5-5m-5 5 5 5"/></svg></button>
      <button type="button" data-direction="left-to-right" title="Appliquer la gauche à droite" aria-label="Appliquer la différence ${index + 1} de gauche à droite"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-5-5m5 5-5 5"/></svg></button>
    </div>`;
  }).join('');
}

function renderMinimap() {
  const total = Math.max(splitLines(els.leftText.value).length, splitLines(els.rightText.value).length, 1);
  els.minimapTrack.innerHTML = hunks.map((hunk, index) => {
    const start = Math.min(hunk.leftStart, hunk.rightStart);
    const size = Math.max(hunk.leftEnd - hunk.leftStart, hunk.rightEnd - hunk.rightStart, 1);
    const top = (start / total) * 100;
    const height = Math.max(0.75, (size / total) * 100);
    return `<span class="minimap-marker ${index === currentHunk ? 'current' : ''}" data-index="${index}" style="top:${top}%;height:${height}%"></span>`;
  }).join('');
  updateMinimapViewport();
}

function syncDecorations(side) {
  const text = side === 'left' ? els.leftText : els.rightText;
  const numbers = side === 'left' ? els.leftLines : els.rightLines;
  const highlights = side === 'left' ? els.leftHighlights : els.rightHighlights;
  numbers.style.transform = `translateY(${-text.scrollTop}px)`;
  highlights.style.transform = `translateY(${-text.scrollTop}px)`;
}

function updateMinimapViewport() {
  const text = els.rightText;
  const maxScroll = Math.max(text.scrollHeight - text.clientHeight, 1);
  const totalHeight = Math.max(text.scrollHeight, 1);
  const ratio = Math.min(1, text.clientHeight / totalHeight);
  const top = (text.scrollTop / maxScroll) * (1 - ratio) * 100;
  els.minimapViewport.style.height = `${Math.max(7, ratio * 100)}%`;
  els.minimapViewport.style.top = `${top}%`;
}

function navigateTo(index, { focus = true } = {}) {
  if (!hunks.length) return;
  currentHunk = (index + hunks.length) % hunks.length;
  const hunk = hunks[currentHunk];
  const scrollToLine = (text, line) => {
    const top = Math.max(0, EDITOR_PADDING + line * LINE_HEIGHT - text.clientHeight * .38);
    text.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  scrollToLine(els.leftText, hunk.leftStart);
  scrollToLine(els.rightText, hunk.rightStart);
  renderLineNumbers(splitLines(els.leftText.value).length, splitLines(els.rightText.value).length);
  renderHighlights();
  renderSummary();
  renderMinimap();
  if (focus) (hunk.rightIndices.length ? els.rightText : els.leftText).focus({ preventScroll: true });
  setTimeout(renderMergeRail, 180);
}

function mergeHunk(index, direction) {
  const hunk = hunks[index];
  if (!hunk) return;
  const left = splitLines(els.leftText.value);
  const right = splitLines(els.rightText.value);

  if (direction === 'left-to-right') {
    right.splice(hunk.rightStart, hunk.rightEnd - hunk.rightStart, ...left.slice(hunk.leftStart, hunk.leftEnd));
    els.rightText.value = right.join('\n');
  } else {
    left.splice(hunk.leftStart, hunk.leftEnd - hunk.leftStart, ...right.slice(hunk.rightStart, hunk.rightEnd));
    els.leftText.value = left.join('\n');
  }
  currentHunk = Math.min(index, hunks.length - 2);
  compareNow({ preserveSelection: true });
  showToast(direction === 'left-to-right' ? 'Modification appliquée à la version de droite.' : 'Modification appliquée à la version de gauche.');
}

function safeFilename(name, fallback) {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!cleaned) return fallback;
  return cleaned.toLowerCase().endsWith('.txt') ? cleaned : `${cleaned}.txt`;
}

function downloadText(side) {
  const text = side === 'left' ? els.leftText.value : els.rightText.value;
  const filename = safeFilename(side === 'left' ? els.leftFilename.value : els.rightFilename.value, `${side}.txt`);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`${filename} téléchargé.`);
}

async function openFile(file, side) {
  if (!file) return;
  const text = await file.text();
  if (side === 'left') {
    els.leftText.value = text;
    els.leftFilename.value = safeFilename(file.name, 'original.txt');
  } else {
    els.rightText.value = text;
    els.rightFilename.value = safeFilename(file.name, 'revision.txt');
  }
  compareNow();
  showToast(`${file.name} chargé.`);
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2200);
}

els.leftText.value = sampleLeft;
els.rightText.value = sampleRight;

[els.leftText, els.rightText].forEach((text) => {
  text.addEventListener('input', scheduleCompare);
  text.addEventListener('paste', () => requestAnimationFrame(compareNow));
  text.addEventListener('scroll', () => {
    const side = text === els.leftText ? 'left' : 'right';
    syncDecorations(side);
    renderMergeRail();
    updateMinimapViewport();
    if (!syncingScroll) {
      syncingScroll = true;
      const other = side === 'left' ? els.rightText : els.leftText;
      const sourceMax = Math.max(text.scrollHeight - text.clientHeight, 1);
      const otherMax = Math.max(other.scrollHeight - other.clientHeight, 1);
      other.scrollTop = (text.scrollTop / sourceMax) * otherMax;
      syncingScroll = false;
    }
  });
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = text.selectionStart;
      text.setRangeText('  ', start, text.selectionEnd, 'end');
      scheduleCompare();
    }
  });
});

els.previousDiff.addEventListener('click', () => navigateTo(currentHunk - 1));
els.nextDiff.addEventListener('click', () => navigateTo(currentHunk + 1));
els.comparisonMode.addEventListener('change', compareNow);
els.downloadLeft.addEventListener('click', () => downloadText('left'));
els.downloadRight.addEventListener('click', () => downloadText('right'));
els.leftFile.addEventListener('change', () => openFile(els.leftFile.files[0], 'left'));
els.rightFile.addEventListener('change', () => openFile(els.rightFile.files[0], 'right'));
els.clearTexts.addEventListener('click', () => {
  els.leftText.value = '';
  els.rightText.value = '';
  compareNow();
  els.leftText.focus();
  showToast('Les deux panneaux ont été vidés.');
});
els.swapTexts.addEventListener('click', () => {
  [els.leftText.value, els.rightText.value] = [els.rightText.value, els.leftText.value];
  [els.leftFilename.value, els.rightFilename.value] = [els.rightFilename.value, els.leftFilename.value];
  compareNow();
  showToast('Les deux versions ont été inversées.');
});
els.mergeRail.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-direction]');
  if (!button) return;
  mergeHunk(Number(button.closest('.merge-action').dataset.index), button.dataset.direction);
});
els.minimap.addEventListener('click', (event) => {
  const marker = event.target.closest('.minimap-marker');
  if (marker) { navigateTo(Number(marker.dataset.index)); return; }
  const rect = els.minimap.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  if (!hunks.length) return;
  const total = Math.max(splitLines(els.leftText.value).length, splitLines(els.rightText.value).length, 1);
  const targetLine = ratio * total;
  let closest = 0;
  hunks.forEach((hunk, index) => {
    const currentDistance = Math.abs(Math.min(hunk.leftStart, hunk.rightStart) - targetLine);
    const bestDistance = Math.abs(Math.min(hunks[closest].leftStart, hunks[closest].rightStart) - targetLine);
    if (currentDistance < bestDistance) closest = index;
  });
  navigateTo(closest);
});
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); navigateTo(currentHunk + 1); }
  if (event.key === 'ArrowUp') { event.preventDefault(); navigateTo(currentHunk - 1); }
});
window.addEventListener('resize', () => { renderMergeRail(); updateMinimapViewport(); });

compareNow();
