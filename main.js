/* eslint-disable no-unused-vars */
(() => {
  "use strict";

  const COLS = 360;
  const ROWS = 240;
  const TOTAL = COLS * ROWS; // 86400

  /** @type {HTMLCanvasElement} */
  const canvas = document.getElementById("dayCanvas");
  /** @type {HTMLDivElement} */
  const canvasHost = document.getElementById("canvasHost");
  /** @type {HTMLDivElement} */
  const tooltipEl = document.getElementById("tooltip");

  /** @type {HTMLOutputElement} */
  const clockEl = document.getElementById("clock");
  /** @type {HTMLInputElement} */
  const fillColorEl = document.getElementById("fillColor");
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
    gridPxW: COLS,
    gridPxH: ROWS,
    offsetCssX: 0, // letterbox offset (CSS px) within host
    offsetCssY: 0,
    fillColor: fillColorEl?.value || "#2d7dff",
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
    const x = index % COLS;
    const y = (index / COLS) | 0;
    return { x, y };
  }

  function paintCell(index) {
    if (index < 0 || index >= TOTAL) return;
    if (filled[index]) return;
    filled[index] = 1;
    const { x, y } = indexToXY(index);
    const s = state.cellSizeCss;
    ctx.fillRect(x * s, y * s, s, s);
  }

  function drawGridLines() {
    // Avoid heavy grid drawing at tiny cell sizes.
    if (!state.showGrid) return;
    if (state.cellSizeCss < 3) return;

    const s = state.cellSizeCss;
    const w = COLS * s;
    const h = ROWS * s;

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;

    // Vertical lines
    for (let x = 0; x <= COLS; x++) {
      const px = x * s + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = 0; y <= ROWS; y++) {
      const py = y * s + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();
    }

    ctx.restore();
  }

  function fullRedraw() {
    // Background
    ctx.fillStyle = "#0b0f1a";
    ctx.fillRect(0, 0, state.gridPxW, state.gridPxH);

    // Filled cells
    ctx.fillStyle = state.fillColor;
    const s = state.cellSizeCss;
    if (s === 1) {
      // 1px cells: fastest path.
      for (let i = 0; i < TOTAL; i++) {
        if (!filled[i]) continue;
        const x = i % COLS;
        const y = (i / COLS) | 0;
        ctx.fillRect(x, y, 1, 1);
      }
    } else {
      for (let i = 0; i < TOTAL; i++) {
        if (!filled[i]) continue;
        const x = i % COLS;
        const y = (i / COLS) | 0;
        ctx.fillRect(x * s, y * s, s, s);
      }
    }

    drawGridLines();
  }

  function computeLayout() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    state.dpr = dpr;

    const hostRect = canvasHost.getBoundingClientRect();
    const availW = Math.max(0, Math.floor(hostRect.width));
    const availH = Math.max(0, Math.floor(hostRect.height));

    // Choose largest integer cell size that fits, but never below 1.
    const fitCell = Math.floor(Math.min(availW / COLS, availH / ROWS));
    const cellSize = Math.max(1, fitCell);
    state.cellSizeCss = cellSize;

    state.gridPxW = COLS * cellSize;
    state.gridPxH = ROWS * cellSize;

    // Center if it fits; if not, rely on scroll.
    state.offsetCssX = Math.max(0, Math.floor((availW - state.gridPxW) / 2));
    state.offsetCssY = Math.max(0, Math.floor((availH - state.gridPxH) / 2));

    // CSS size
    canvas.style.width = `${state.gridPxW}px`;
    canvas.style.height = `${state.gridPxH}px`;
    canvas.style.marginLeft = `${state.offsetCssX}px`;
    canvas.style.marginTop = `${state.offsetCssY}px`;

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
        // After bulk fill, redraw grid overlay once.
        drawGridLines();
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
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return -1;
    return row * COLS + col;
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
    fillColorEl.addEventListener("input", () => {
      state.fillColor = fillColorEl.value;
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
    showGridEl.checked = state.showGrid;
    startFromNowEl.checked = state.startFromNow;

    bindUI();
    initFilledFromMode();
    tick();
  }

  init();
})();
