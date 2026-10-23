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
let alignmentAnchors = [{ left: 0, right: 0 }];
let minimapDragging = false;
let minimapDragOffset = 0;
let minimapDragMoved = false;

function splitLines(value) {
  return value.replace(/\r\n?/g, '\n').split('\n');
}

function comparable(line) {
  return els.comparisonMode.value === 'trim' ? line.replace(/[ \t]+$/g, '') : line;
}

function buildLcsSegment(leftLines, rightLines, leftStart, leftEnd, rightStart, rightEnd) {
  const n = leftEnd - leftStart;
  const m = rightEnd - rightStart;
  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      rows[i][j] = comparable(leftLines[leftStart + i]) === comparable(rightLines[rightStart + j])
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (comparable(leftLines[leftStart + i]) === comparable(rightLines[rightStart + j])) {
      ops.push({ type: 'equal', left: leftStart + i, right: rightStart + j });
      i += 1;
      j += 1;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      ops.push({ type: 'remove', left: leftStart + i });
      i += 1;
    } else {
      ops.push({ type: 'add', right: rightStart + j });
      j += 1;
    }
  }
  while (i < n) { ops.push({ type: 'remove', left: leftStart + i }); i += 1; }
  while (j < m) { ops.push({ type: 'add', right: rightStart + j }); j += 1; }
  return ops;
}

function findPatienceAnchors(leftLines, rightLines, leftStart, leftEnd, rightStart, rightEnd) {
  const leftOccurrences = new Map();
  const rightOccurrences = new Map();

  for (let i = leftStart; i < leftEnd; i += 1) {
    const key = comparable(leftLines[i]);
    const entry = leftOccurrences.get(key) || { count: 0, index: i };
    entry.count += 1;
    entry.index = i;
    leftOccurrences.set(key, entry);
  }
  for (let i = rightStart; i < rightEnd; i += 1) {
    const key = comparable(rightLines[i]);
    const entry = rightOccurrences.get(key) || { count: 0, index: i };
    entry.count += 1;
    entry.index = i;
    rightOccurrences.set(key, entry);
  }

  const pairs = [];
  leftOccurrences.forEach((leftEntry, key) => {
    const rightEntry = rightOccurrences.get(key);
    if (leftEntry.count === 1 && rightEntry?.count === 1) {
      pairs.push({ left: leftEntry.index, right: rightEntry.index });
    }
  });
  pairs.sort((a, b) => a.left - b.left);
  if (!pairs.length) return [];

  const tails = [];
  const tailIndices = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < pair.right) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tailIndices[low - 1];
    tails[low] = pair.right;
    tailIndices[low] = index;
  });

  const anchors = [];
  let cursor = tailIndices[tails.length - 1];
  while (cursor >= 0) {
    anchors.push(pairs[cursor]);
    cursor = previous[cursor];
  }
  return anchors.reverse();
}

function diffRange(leftLines, rightLines, leftStart, leftEnd, rightStart, rightEnd, ops) {
  while (leftStart < leftEnd && rightStart < rightEnd
    && comparable(leftLines[leftStart]) === comparable(rightLines[rightStart])) {
    ops.push({ type: 'equal', left: leftStart, right: rightStart });
    leftStart += 1;
    rightStart += 1;
  }

  const suffix = [];
  while (leftStart < leftEnd && rightStart < rightEnd
    && comparable(leftLines[leftEnd - 1]) === comparable(rightLines[rightEnd - 1])) {
    leftEnd -= 1;
    rightEnd -= 1;
    suffix.push({ type: 'equal', left: leftEnd, right: rightEnd });
  }

  if (leftStart === leftEnd || rightStart === rightEnd) {
    for (let i = leftStart; i < leftEnd; i += 1) ops.push({ type: 'remove', left: i });
    for (let i = rightStart; i < rightEnd; i += 1) ops.push({ type: 'add', right: i });
  } else if ((leftEnd - leftStart) * (rightEnd - rightStart) <= MAX_LCS_CELLS) {
    ops.push(...buildLcsSegment(leftLines, rightLines, leftStart, leftEnd, rightStart, rightEnd));
  } else {
    const anchors = findPatienceAnchors(leftLines, rightLines, leftStart, leftEnd, rightStart, rightEnd);
    if (anchors.length) {
      let previousLeft = leftStart;
      let previousRight = rightStart;
      anchors.forEach((anchor) => {
        diffRange(leftLines, rightLines, previousLeft, anchor.left, previousRight, anchor.right, ops);
        ops.push({ type: 'equal', left: anchor.left, right: anchor.right });
        previousLeft = anchor.left + 1;
        previousRight = anchor.right + 1;
      });
      diffRange(leftLines, rightLines, previousLeft, leftEnd, previousRight, rightEnd, ops);
    } else {
      for (let i = leftStart; i < leftEnd; i += 1) ops.push({ type: 'remove', left: i });
      for (let i = rightStart; i < rightEnd; i += 1) ops.push({ type: 'add', right: i });
    }
  }

  for (let i = suffix.length - 1; i >= 0; i -= 1) ops.push(suffix[i]);
}

function buildDiff(leftLines, rightLines) {
  const ops = [];
  diffRange(leftLines, rightLines, 0, leftLines.length, 0, rightLines.length, ops);
  return ops;
}

function buildAlignmentAnchors(ops, leftCount, rightCount) {
  const anchors = [{ left: 0, right: 0 }];
  ops.forEach((op) => {
    if (op.type !== 'equal') return;
    const previous = anchors.at(-1);
    if (op.left !== previous.left || op.right !== previous.right) {
      anchors.push({ left: op.left, right: op.right });
    }
  });
  const last = anchors.at(-1);
  if (last.left !== leftCount || last.right !== rightCount) anchors.push({ left: leftCount, right: rightCount });
  return anchors;
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
  const ops = buildDiff(left, right);
  hunks = groupHunks(ops);
  alignmentAnchors = buildAlignmentAnchors(ops, left.length, right.length);

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

function changedLineTypes(side) {
  const changed = new Map();
  hunks.forEach((hunk) => {
    const indices = side === 'left' ? hunk.leftIndices : hunk.rightIndices;
    indices.forEach((index) => changed.set(index, side === 'left' ? 'removed' : 'added'));
  });
  return changed;
}

function renderLineNumbers(leftCount, rightCount) {
  const render = (count, target, side) => {
    const changed = changedLineTypes(side);
    const active = currentHunk >= 0 ? new Set(side === 'left' ? hunks[currentHunk].leftIndices : hunks[currentHunk].rightIndices) : new Set();
    target.innerHTML = Array.from({ length: count }, (_, index) => {
      const classes = [changed.get(index) || '', active.has(index) ? 'current' : ''].filter(Boolean).join(' ');
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
      const lineType = side === 'left' ? 'removed' : 'added';
      indices.forEach((line) => {
        blocks.push(`<span class="highlight-line ${lineType} ${hunkIndex === currentHunk ? 'current' : ''}" data-line="${line}" style="top:${EDITOR_PADDING + line * LINE_HEIGHT}px"></span>`);
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
  const clampY = (value) => Math.max(0, Math.min(editorHeight, value));
  els.mergeRail.innerHTML = hunks.map((hunk, index) => {
    const leftSize = hunk.leftEnd - hunk.leftStart;
    const rightSize = hunk.rightEnd - hunk.rightStart;
    const leftTop = EDITOR_PADDING + hunk.leftStart * LINE_HEIGHT - leftScroll;
    const rightTop = EDITOR_PADDING + hunk.rightStart * LINE_HEIGHT - rightScroll;
    const leftBottom = leftTop + Math.max(leftSize * LINE_HEIGHT, 4);
    const rightBottom = rightTop + Math.max(rightSize * LINE_HEIGHT, 4);
    const visible = leftBottom >= 0 && leftTop <= editorHeight || rightBottom >= 0 && rightTop <= editorHeight;
    const leftMiddle = (leftTop + leftBottom) / 2;
    const rightMiddle = (rightTop + rightBottom) / 2;
    const rawTop = headerOffset + (leftMiddle + rightMiddle) / 2;
    const top = Math.max(headerOffset + 18, Math.min(headerOffset + editorHeight - 18, rawTop));
    const bridgeClass = hunk.type === 'change' ? 'changed' : hunk.type;
    const bridge = visible ? `<svg class="diff-bridge ${bridgeClass} ${index === currentHunk ? 'current' : ''}" data-index="${index}" style="top:${headerOffset}px;height:${editorHeight}px" viewBox="0 0 100 ${editorHeight}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="bridge-${index}" x1="0" x2="1"><stop offset="0" stop-color="#ff4d59"/><stop offset="1" stop-color="#64e68a"/></linearGradient></defs>
      <path d="M0 ${clampY(leftTop)} L0 ${clampY(leftBottom)} L100 ${clampY(rightBottom)} L100 ${clampY(rightTop)} Z"${hunk.type === 'change' ? ` fill="url(#bridge-${index})"` : ''}/>
    </svg>` : '';
    return `${bridge}<div class="merge-action" style="top:${top}px;${visible ? '' : 'display:none'}" data-index="${index}">
      <button type="button" data-direction="right-to-left" title="Appliquer la droite à gauche" aria-label="Appliquer la différence ${index + 1} de droite à gauche"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 5-5m-5 5 5 5"/></svg></button>
      <button type="button" data-direction="left-to-right" title="Appliquer la gauche à droite" aria-label="Appliquer la différence ${index + 1} de gauche à droite"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-5-5m5 5-5 5"/></svg></button>
    </div>`;
  }).join('');
}

function renderMinimap() {
  const leftTotal = Math.max(splitLines(els.leftText.value).length, 1);
  const rightTotal = Math.max(splitLines(els.rightText.value).length, 1);
  els.minimapTrack.innerHTML = hunks.map((hunk, index) => {
    const active = index === currentHunk ? 'current' : '';
    const markers = [];
    if (hunk.leftIndices.length) {
      markers.push(`<span class="minimap-marker removed ${active}" data-index="${index}" style="top:${(hunk.leftStart / leftTotal) * 100}%;height:${Math.max(.75, ((hunk.leftEnd - hunk.leftStart) / leftTotal) * 100)}%"></span>`);
    }
    if (hunk.rightIndices.length) {
      markers.push(`<span class="minimap-marker added ${active}" data-index="${index}" style="top:${(hunk.rightStart / rightTotal) * 100}%;height:${Math.max(.75, ((hunk.rightEnd - hunk.rightStart) / rightTotal) * 100)}%"></span>`);
    }
    return markers.join('');
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
  const visibleRatio = Math.max(.07, ratio);
  const top = (text.scrollTop / maxScroll) * (1 - visibleRatio) * 100;
  els.minimapViewport.style.height = `${visibleRatio * 100}%`;
  els.minimapViewport.style.top = `${top}%`;
  els.minimap.setAttribute('aria-valuenow', String(Math.round((text.scrollTop / maxScroll) * 100)));
}

function mapLineAcross(side, line) {
  const sourceKey = side;
  const targetKey = side === 'left' ? 'right' : 'left';
  let previous = alignmentAnchors[0];
  for (let index = 1; index < alignmentAnchors.length; index += 1) {
    const next = alignmentAnchors[index];
    if (line <= next[sourceKey]) {
      const span = next[sourceKey] - previous[sourceKey];
      if (span <= 0) return next[targetKey];
      const progress = (line - previous[sourceKey]) / span;
      return previous[targetKey] + progress * (next[targetKey] - previous[targetKey]);
    }
    previous = next;
  }
  return alignmentAnchors.at(-1)[targetKey];
}

function syncOtherEditor(source, side) {
  const other = side === 'left' ? els.rightText : els.leftText;
  const sourceLine = source.scrollTop / LINE_HEIGHT;
  const targetLine = mapLineAcross(side, sourceLine);
  other.scrollTop = Math.max(0, Math.min(other.scrollHeight - other.clientHeight, targetLine * LINE_HEIGHT));
}

function scrollEditorsToRatio(ratio) {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  syncingScroll = true;
  [els.leftText, els.rightText].forEach((text) => {
    text.scrollTop = safeRatio * Math.max(text.scrollHeight - text.clientHeight, 0);
  });
  syncingScroll = false;
  syncDecorations('left');
  syncDecorations('right');
  renderMergeRail();
  updateMinimapViewport();
}

function ratioFromMinimapPointer(event) {
  const rect = els.minimap.getBoundingClientRect();
  const viewportHeight = els.minimapViewport.getBoundingClientRect().height;
  const available = Math.max(rect.height - viewportHeight, 1);
  return (event.clientY - rect.top - minimapDragOffset) / available;
}

function navigateTo(index, { focus = false } = {}) {
  if (!hunks.length) return;
  currentHunk = (index + hunks.length) % hunks.length;
  const hunk = hunks[currentHunk];
  const scrollTopForLine = (text, line) => Math.max(
    0,
    Math.min(text.scrollHeight - text.clientHeight, EDITOR_PADDING + line * LINE_HEIGHT - text.clientHeight * .38),
  );
  syncingScroll = true;
  els.leftText.scrollTop = scrollTopForLine(els.leftText, hunk.leftStart);
  els.rightText.scrollTop = scrollTopForLine(els.rightText, hunk.rightStart);
  syncingScroll = false;
  syncDecorations('left');
  syncDecorations('right');
  renderLineNumbers(splitLines(els.leftText.value).length, splitLines(els.rightText.value).length);
  renderHighlights();
  renderSummary();
  renderMinimap();
  renderMergeRail();
  if (focus) (hunk.rightIndices.length ? els.rightText : els.leftText).focus({ preventScroll: true });
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
      syncOtherEditor(text, side);
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
  if (button) {
    mergeHunk(Number(button.closest('.merge-action').dataset.index), button.dataset.direction);
    return;
  }
  const bridge = event.target.closest('.diff-bridge[data-index]');
  if (bridge) navigateTo(Number(bridge.dataset.index));
});
els.minimap.addEventListener('click', (event) => {
  if (minimapDragMoved) { minimapDragMoved = false; return; }
  const marker = event.target.closest('.minimap-marker');
  if (marker) { navigateTo(Number(marker.dataset.index)); return; }
  scrollEditorsToRatio(ratioFromMinimapPointer(event));
});
els.minimap.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const viewportRect = els.minimapViewport.getBoundingClientRect();
  minimapDragging = true;
  minimapDragMoved = false;
  minimapDragOffset = event.target === els.minimapViewport
    ? event.clientY - viewportRect.top
    : viewportRect.height / 2;
  els.minimap.setPointerCapture(event.pointerId);
  if (event.target !== els.minimapViewport && !event.target.closest('.minimap-marker')) {
    scrollEditorsToRatio(ratioFromMinimapPointer(event));
  }
});
els.minimap.addEventListener('pointermove', (event) => {
  if (!minimapDragging) return;
  minimapDragMoved = true;
  scrollEditorsToRatio(ratioFromMinimapPointer(event));
});
const stopMinimapDrag = (event) => {
  if (!minimapDragging) return;
  minimapDragging = false;
  if (els.minimap.hasPointerCapture(event.pointerId)) els.minimap.releasePointerCapture(event.pointerId);
};
els.minimap.addEventListener('pointerup', stopMinimapDrag);
els.minimap.addEventListener('pointercancel', stopMinimapDrag);
els.minimap.addEventListener('keydown', (event) => {
  const current = Number(els.minimap.getAttribute('aria-valuenow') || 0) / 100;
  const step = event.shiftKey ? .2 : .05;
  if (event.key === 'Home') { event.preventDefault(); scrollEditorsToRatio(0); }
  if (event.key === 'End') { event.preventDefault(); scrollEditorsToRatio(1); }
  if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); scrollEditorsToRatio(current - step); }
  if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); scrollEditorsToRatio(current + step); }
});
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); navigateTo(currentHunk + 1); }
  if (event.key === 'ArrowUp') { event.preventDefault(); navigateTo(currentHunk - 1); }
});
window.addEventListener('resize', () => { renderMergeRail(); updateMinimapViewport(); });

compareNow();
