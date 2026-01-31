/* eslint-disable no-unused-vars */
(() => {
  "use strict";

  const TOTAL = 86400;

  const factorPairs = (() => {
    /** @type {{cols:number, rows:number}[]} */
    const pairs = [];
    for (let a = 1; a * a <= TOTAL; a++) {
      if (TOTAL % a !== 0) continue;
      const b = TOTAL / a;
      pairs.push({ cols: b, rows: a });
      if (a !== b) pairs.push({ cols: a, rows: b });
    }
    return pairs;
  })();

  /** @type {HTMLCanvasElement} */
  const canvas = document.getElementById("dayCanvas");
  /** @type {HTMLDivElement} */
  const canvasHost = document.getElementById("canvasHost");
  /** @type {HTMLDivElement} */
  const tooltipEl = document.getElementById("tooltip");

  /** @type {HTMLButtonElement} */
  const menuBtn = document.getElementById("menuBtn");
  /** @type {HTMLDivElement} */
  const backdropEl = document.getElementById("backdrop");
  /** @type {HTMLElement} */
  const drawerEl = document.getElementById("drawer");
  /** @type {HTMLButtonElement} */
  const closeDrawerBtn = document.getElementById("closeDrawer");

  /** @type {HTMLOutputElement} */
  const clockEl = document.getElementById("clock");
  /** @type {HTMLInputElement} */
  const fillColorEl = document.getElementById("fillColor");
  /** @type {HTMLInputElement} */
  const emptyColorEl = document.getElementById("emptyColor");
  /** @type {HTMLInputElement} */
  const showGridEl = document.getElementById("showGrid");
  /** @type {HTMLInputElement} */
  const startFromNowEl = document.getElementById("startFromNow");
  /** @type {HTMLButtonElement} */
  const togglePauseBtn = document.getElementById("togglePause");
  /** @type {HTMLButtonElement} */
  const resetBtn = document.getElementById("reset");

  const filled = new Uint8Array(TOTAL);

  const state = {
    dpr: 1,
    cellSizeCss: 1, // in CSS pixels
    cols: 360,
    rows: 240,
    gridPxW: 360,
    gridPxH: 240,
    offsetCssX: 0, // letterbox offset (CSS px) within host
    offsetCssY: 0,
    fillColor: fillColorEl?.value || "#2d7dff",
    emptyColor: emptyColorEl?.value || "#ffffff",
    showGrid: !!showGridEl?.checked,
    startFromNow: true,
    paused: false,
    lastFilled: -1,
    timerId: /** @type {number|null} */ (null),

    rafActive: false,
    catchUpFrom: -1,
    catchUpTo: -1,
    renderBudgetCellsPerFrame: 3500,
  };

  /** @type {CanvasRenderingContext2D} */
  const ctx = (() => {
    const c = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!c) throw new Error("Canvas 2D context not available");
    return c;
  })();

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatHMSFromSec(sec) {
    const s = ((sec % 86400) + 86400) % 86400;
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }

  function secondsSinceMidnight(d) {
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }

  function clearAll() {
    filled.fill(0);
    state.lastFilled = -1;
    state.catchUpFrom = -1;
    state.catchUpTo = -1;

    // Clear canvas to background.
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0b0f1a";
    ctx.fillRect(0, 0, state.gridPxW, state.gridPxH);
  }

  function updateClockText(now = new Date()) {
    clockEl.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  }

  function indexToXY(index) {
    const x = index % state.cols;
    const y = (index / state.cols) | 0;
    return { x, y };
  }

  function paintCell(index) {
    if (index < 0 || index >= TOTAL) return;
    if (filled[index]) return;
    filled[index] = 1;
    const { x, y } = indexToXY(index);
    const s = state.cellSizeCss;
    const gap = state.showGrid && s >= 2 ? 1 : 0;
    const w = s - gap;
    ctx.fillRect(x * s, y * s, w, w);
  }

  function fullRedraw() {
    // Background
    ctx.fillStyle = "#0b0f1a";
    ctx.fillRect(0, 0, state.gridPxW, state.gridPxH);

    const s = state.cellSizeCss;
    const gap = state.showGrid && s >= 2 ? 1 : 0;
    const w = s - gap;

    // Empty cells (draw once per full redraw)
    ctx.fillStyle = state.emptyColor;
    if (s === 1) {
      // 1px cells: empty is full fill.
      ctx.fillRect(0, 0, state.cols, state.rows);
    } else {
      for (let i = 0; i < TOTAL; i++) {
        const x = i % state.cols;
        const y = (i / state.cols) | 0;
        ctx.fillRect(x * s, y * s, w, w);
      }
    }

    // Filled cells overlay
    ctx.fillStyle = state.fillColor;
    if (s === 1) {
      // 1px cells: fastest path for filled overlay.
      for (let i = 0; i < TOTAL; i++) {
        if (!filled[i]) continue;
        const x = i % state.cols;
        const y = (i / state.cols) | 0;
        ctx.fillRect(x, y, 1, 1);
      }
    } else {
      for (let i = 0; i < TOTAL; i++) {
        if (!filled[i]) continue;
        const x = i % state.cols;
        const y = (i / state.cols) | 0;
        ctx.fillRect(x * s, y * s, w, w);
      }
    }
  }

  function pickBestGrid(availW, availH) {
    const aspect = availW > 0 && availH > 0 ? availW / availH : 1.5;
    /** @type {{cols:number, rows:number, score:number, cell:number}|null} */
    let best = null;

    for (const p of factorPairs) {
      const ratio = p.cols / p.rows;
      const score = Math.abs(Math.log(ratio / aspect));
      const cell = Math.max(1, Math.floor(Math.min(availW / p.cols, availH / p.rows)));
      const candidate = { cols: p.cols, rows: p.rows, score, cell };

      if (!best) {
        best = candidate;
        continue;
      }

      // Primary: closest aspect. Secondary: bigger cell size.
      if (candidate.score < best.score - 1e-6) {
        best = candidate;
      } else if (Math.abs(candidate.score - best.score) <= 1e-6 && candidate.cell > best.cell) {
        best = candidate;
      }
    }

    // Fallback
    return best || { cols: 360, rows: 240, score: 0, cell: 1 };
  }

  function computeLayout() {
    const hostRect = canvasHost.getBoundingClientRect();
    const availW = Math.max(0, Math.floor(hostRect.width));
    const availH = Math.max(0, Math.floor(hostRect.height));

    // Choose a grid (cols×rows) whose aspect matches the screen best,
    // then fit it fully (no scroll).
    const best = pickBestGrid(availW, availH);
    state.cols = best.cols;
    state.rows = best.rows;
    // Cover (no empty margins): grid becomes >= host and is cropped by overflow:hidden.
    // Use integer size for crisp cells.
    let cellSize = Math.max(1, Math.max(Math.ceil(availW / state.cols), Math.ceil(availH / state.rows)));

    // Safety cap: keep canvas backing store under ~48MB of pixels (RGBA).
    const maxPixels = 12_000_000;
    while (cellSize > 1) {
      const areaCss = (state.cols * cellSize) * (state.rows * cellSize);
      if (areaCss <= maxPixels) break;
      cellSize--;
    }
    state.cellSizeCss = cellSize;

    state.gridPxW = state.cols * cellSize;
    state.gridPxH = state.rows * cellSize;

    // Center the grid; offsets may be negative (cropping) in cover mode.
    state.offsetCssX = Math.floor((availW - state.gridPxW) / 2);
    state.offsetCssY = Math.floor((availH - state.gridPxH) / 2);

    // CSS size
    canvas.style.width = `${state.gridPxW}px`;
    canvas.style.height = `${state.gridPxH}px`;
    canvas.style.marginLeft = `${state.offsetCssX}px`;
    canvas.style.marginTop = `${state.offsetCssY}px`;

    // DPR: cap to avoid huge backing store on large screens.
    const deviceDpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const areaCss = state.gridPxW * state.gridPxH;
    const maxDprForBudget = Math.sqrt(maxPixels / Math.max(1, areaCss));
    const dpr = clamp(Math.min(deviceDpr, maxDprForBudget), 1, 3);
    state.dpr = dpr;

    // Backing store (scaled by dpr)
    canvas.width = Math.max(1, Math.round(state.gridPxW * dpr));
    canvas.height = Math.max(1, Math.round(state.gridPxH * dpr));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function requestRaf() {
    if (state.rafActive) return;
    state.rafActive = true;
    requestAnimationFrame(renderFrame);
  }

  function setCatchUpRange(fromInclusive, toInclusive) {
    const from = clamp(fromInclusive, 0, TOTAL - 1);
    const to = clamp(toInclusive, 0, TOTAL - 1);
    if (to < from) return;
    state.catchUpFrom = from;
    state.catchUpTo = to;
    requestRaf();
  }

  function renderFrame() {
    state.rafActive = false;

    // Draw pending fill range, chunked.
    if (state.catchUpFrom >= 0 && state.catchUpTo >= state.catchUpFrom) {
      ctx.fillStyle = state.fillColor;

      const budget = state.renderBudgetCellsPerFrame;
      let drawn = 0;
      while (state.catchUpFrom <= state.catchUpTo && drawn < budget) {
        paintCell(state.catchUpFrom);
        state.catchUpFrom++;
        drawn++;
      }

      if (state.catchUpFrom > state.catchUpTo) {
        state.catchUpFrom = -1;
        state.catchUpTo = -1;
      } else {
        requestRaf();
      }
    }
  }

  function tick() {
    if (state.paused) return;

    const now = new Date();
    updateClockText(now);

    const target = secondsSinceMidnight(now);

    // Day rollover: new day starts.
    if (state.lastFilled >= 0 && target < state.lastFilled) {
      clearAll();
      fullRedraw();
    }

    if (target > state.lastFilled) {
      const from = state.lastFilled + 1;
      const to = target;
      state.lastFilled = target;
      setCatchUpRange(from, to);
    } else if (target === 0 && state.lastFilled < 0) {
      // at exact midnight initial state
      state.lastFilled = 0;
      setCatchUpRange(0, 0);
    }

    scheduleNextTick(now);
  }

  function scheduleNextTick(now = new Date()) {
    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }
    if (state.paused) return;

    // Align to the next second boundary to avoid drift.
    const ms = now.getMilliseconds();
    const msToNext = Math.max(10, 1000 - ms + 2); // +2ms to cross boundary

    state.timerId = window.setTimeout(() => tick(), msToNext);
  }

  function applySettingsFromStorage() {
    try {
      const raw = localStorage.getItem("secDaySettings_v1");
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.fillColor === "string") state.fillColor = s.fillColor;
      if (typeof s.emptyColor === "string") state.emptyColor = s.emptyColor;
      if (typeof s.showGrid === "boolean") state.showGrid = s.showGrid;
      if (typeof s.startFromNow === "boolean") state.startFromNow = s.startFromNow;
    } catch {
      // ignore
    }
  }

  function persistSettings() {
    try {
      localStorage.setItem(
        "secDaySettings_v1",
        JSON.stringify({
          fillColor: state.fillColor,
          emptyColor: state.emptyColor,
          showGrid: state.showGrid,
          startFromNow: state.startFromNow,
        }),
      );
    } catch {
      // ignore
    }
  }

  function initFilledFromMode() {
    clearAll();
    computeLayout();
    fullRedraw();

    const now = new Date();
    updateClockText(now);
    const target = secondsSinceMidnight(now);

    if (state.startFromNow) {
      // Fill all past seconds up to target (inclusive).
      state.lastFilled = target;
      setCatchUpRange(0, target);
    } else {
      // Start fresh at 0 and fill as time passes.
      state.lastFilled = -1;
    }
  }

  function onResize() {
    // Recompute layout and redraw everything.
    const prevCell = state.cellSizeCss;
    computeLayout();
    // If only CSS size changes, still need redraw because backing store changed.
    fullRedraw();
  }

  function pointerToCellIndex(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return -1;

    const s = state.cellSizeCss;
    const col = Math.floor(x / s);
    const row = Math.floor(y / s);
    if (col < 0 || col >= state.cols || row < 0 || row >= state.rows) return -1;
    return row * state.cols + col;
  }

  function showTooltip(text, clientX, clientY) {
    tooltipEl.textContent = text;
    tooltipEl.dataset.visible = "true";
    tooltipEl.setAttribute("aria-hidden", "false");

    const margin = 12;
    const x = clientX + margin;
    const y = clientY + margin;

    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${y}px`;
  }

  function hideTooltip() {
    tooltipEl.dataset.visible = "false";
    tooltipEl.setAttribute("aria-hidden", "true");
  }

  function bindUI() {
    function setDrawerOpen(isOpen) {
      drawerEl.dataset.open = isOpen ? "true" : "false";
      drawerEl.setAttribute("aria-hidden", isOpen ? "false" : "true");
      menuBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");

      if (isOpen) {
        backdropEl.hidden = false;
      } else {
        backdropEl.hidden = true;
        hideTooltip();
      }
      // Recompute layout in case scrollbar visibility changed.
      onResize();
    }

    menuBtn.addEventListener("click", () => setDrawerOpen(true));
    closeDrawerBtn.addEventListener("click", () => setDrawerOpen(false));
    backdropEl.addEventListener("click", () => setDrawerOpen(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setDrawerOpen(false);
    });

    fillColorEl.addEventListener("input", () => {
      state.fillColor = fillColorEl.value;
      persistSettings();
      fullRedraw();
    });

    emptyColorEl.addEventListener("input", () => {
      state.emptyColor = emptyColorEl.value;
      persistSettings();
      fullRedraw();
    });

    showGridEl.addEventListener("change", () => {
      state.showGrid = showGridEl.checked;
      persistSettings();
      fullRedraw();
    });

    startFromNowEl.addEventListener("change", () => {
      state.startFromNow = startFromNowEl.checked;
      persistSettings();
      initFilledFromMode();
      if (!state.paused) scheduleNextTick();
    });

    togglePauseBtn.addEventListener("click", () => {
      state.paused = !state.paused;
      togglePauseBtn.textContent = state.paused ? "Возобновить" : "Пауза";
      if (!state.paused) {
        // Catch up immediately on resume.
        tick();
      } else {
        if (state.timerId != null) {
          window.clearTimeout(state.timerId);
          state.timerId = null;
        }
      }
    });

    resetBtn.addEventListener("click", () => {
      initFilledFromMode();
      if (!state.paused) tick();
    });

    // Tooltip (mouse + touch via pointer events)
    canvas.addEventListener("pointermove", (e) => {
      const idx = pointerToCellIndex(e.clientX, e.clientY);
      if (idx < 0) {
        hideTooltip();
        return;
      }
      showTooltip(formatHMSFromSec(idx), e.clientX, e.clientY);
    });

    canvas.addEventListener("pointerleave", () => hideTooltip());
    canvas.addEventListener("pointerdown", (e) => {
      // On touch, show tooltip on press.
      if (e.pointerType === "touch") {
        const idx = pointerToCellIndex(e.clientX, e.clientY);
        if (idx >= 0) showTooltip(formatHMSFromSec(idx), e.clientX, e.clientY);
      }
    });
    canvas.addEventListener("pointerup", (e) => {
      if (e.pointerType === "touch") hideTooltip();
    });
    canvas.addEventListener("pointercancel", () => hideTooltip());

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !state.paused) {
        tick(); // catch up immediately
      }
    });

    window.addEventListener("resize", () => onResize(), { passive: true });
  }

  function init() {
    applySettingsFromStorage();

    // Apply settings to controls.
    fillColorEl.value = state.fillColor;
    emptyColorEl.value = state.emptyColor;
    showGridEl.checked = state.showGrid;
    startFromNowEl.checked = state.startFromNow;

    bindUI();
    initFilledFromMode();
    tick();
  }

  init();
})();
