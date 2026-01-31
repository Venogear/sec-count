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

  /** @type {HTMLDivElement} */
  const layoutModesEl = document.getElementById("layoutModes");
  /** @type {HTMLOutputElement} */
  const gridInfoEl = document.getElementById("gridInfo");
  /** @type {HTMLInputElement} */
  const gridColsEl = document.getElementById("gridCols");
  /** @type {HTMLInputElement} */
  const gridRowsEl = document.getElementById("gridRows");
  /** @type {HTMLButtonElement} */
  const applyGridBtn = document.getElementById("applyGrid");
  /** @type {HTMLButtonElement} */
  const autoGridBtn = document.getElementById("autoGrid");
  /** @type {HTMLDivElement} */
  const gridErrorEl = document.getElementById("gridError");

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
    cellW: 1, // stretch mode: css px per cell in X
    cellH: 1, // stretch mode: css px per cell in Y
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
    // fit: fixed 360×240, contain (no crop)
    // fill: fixed 360×240, cover (crop)
    // stretch: fixed 360×240, fill (rectangular cells)
    // auto: best factor grid, contain (no crop)
    layoutMode: /** @type {"fit"|"fill"|"stretch"|"auto"} */ ("auto"),
    gridMode: /** @type {"auto"|"custom"} */ ("auto"),
    customCols: 360,
    customRows: 240,
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

  function setGridError(msg) {
    if (!gridErrorEl) return;
    gridErrorEl.textContent = msg || "";
  }

  function isValidGrid(cols, rows) {
    return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0 && cols * rows === TOTAL;
  }

  function updateGridUI() {
    if (gridColsEl) gridColsEl.value = String(state.customCols);
    if (gridRowsEl) gridRowsEl.value = String(state.customRows);
    if (gridInfoEl) {
      gridInfoEl.textContent = `Сетка: ${state.cols}×${state.rows} (${state.gridMode === "custom" ? "ручная" : "авто"})`;
    }
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
    if (state.layoutMode === "stretch") {
      const cw = state.cellW;
      const ch = state.cellH;
      const gap = state.showGrid && Math.min(cw, ch) >= 2 ? 1 : 0;
      ctx.fillRect(x * cw, y * ch, Math.max(1, cw - gap), Math.max(1, ch - gap));
      return;
    }

    const s = state.cellSizeCss;
    const gap = state.showGrid && s >= 2 ? 1 : 0;
    const w = s - gap;
    ctx.fillRect(x * s, y * s, w, w);
  }

  function fullRedraw() {
    // Background
    ctx.fillStyle = "#0b0f1a";
    ctx.fillRect(0, 0, state.gridPxW, state.gridPxH);

    if (state.layoutMode === "stretch") {
      const cw = state.cellW;
      const ch = state.cellH;
      const gap = state.showGrid && Math.min(cw, ch) >= 2 ? 1 : 0;
      const w = Math.max(1, cw - gap);
      const h = Math.max(1, ch - gap);

      ctx.fillStyle = state.emptyColor;
      for (let i = 0; i < TOTAL; i++) {
        const x = i % state.cols;
        const y = (i / state.cols) | 0;
        ctx.fillRect(x * cw, y * ch, w, h);
      }

      ctx.fillStyle = state.fillColor;
      for (let i = 0; i < TOTAL; i++) {
        if (!filled[i]) continue;
        const x = i % state.cols;
        const y = (i / state.cols) | 0;
        ctx.fillRect(x * cw, y * ch, w, h);
      }
      return;
    }

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

    const maxPixels = 12_000_000;

    // Always choose grid shape dynamically (divisors of 86 400).
    // Modes now only affect scaling (contain/cover/stretch), not the grid dimensions.
    if (state.gridMode === "custom" && isValidGrid(state.customCols, state.customRows)) {
      state.cols = state.customCols;
      state.rows = state.customRows;
    } else {
      const best = pickBestGrid(availW, availH);
      state.cols = best.cols;
      state.rows = best.rows;
    }

    // Default for square modes.
    state.cellW = 1;
    state.cellH = 1;

    if (state.layoutMode === "stretch") {
      // Fill host exactly; cells become rectangles.
      state.cellSizeCss = 1;
      state.gridPxW = availW;
      state.gridPxH = availH;
      state.offsetCssX = 0;
      state.offsetCssY = 0;
      state.cellW = availW / Math.max(1, state.cols);
      state.cellH = availH / Math.max(1, state.rows);

      canvas.style.width = `${availW}px`;
      canvas.style.height = `${availH}px`;
      canvas.style.marginLeft = "0px";
      canvas.style.marginTop = "0px";
    } else {
      // Square cells, integer size for crispness.
      let cellSize;
      if (state.layoutMode === "fill") {
        // Cover: can crop.
        cellSize = Math.max(1, Math.ceil(Math.max(availW / state.cols, availH / state.rows)));
      } else {
        // fit + auto: contain.
        cellSize = Math.max(1, Math.floor(Math.min(availW / state.cols, availH / state.rows)));
      }

      while (cellSize > 1) {
        const areaCss = (state.cols * cellSize) * (state.rows * cellSize);
        if (areaCss <= maxPixels) break;
        cellSize--;
      }

      state.cellSizeCss = cellSize;
      state.gridPxW = state.cols * cellSize;
      state.gridPxH = state.rows * cellSize;

      if (state.layoutMode === "fill") {
        state.offsetCssX = Math.floor((availW - state.gridPxW) / 2);
        state.offsetCssY = Math.floor((availH - state.gridPxH) / 2);
      } else {
        state.offsetCssX = Math.max(0, Math.floor((availW - state.gridPxW) / 2));
        state.offsetCssY = Math.max(0, Math.floor((availH - state.gridPxH) / 2));
      }

      canvas.style.width = `${state.gridPxW}px`;
      canvas.style.height = `${state.gridPxH}px`;
      canvas.style.marginLeft = `${state.offsetCssX}px`;
      canvas.style.marginTop = `${state.offsetCssY}px`;
    }

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

    updateGridUI();
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
      if (s.layoutMode === "fit" || s.layoutMode === "fill" || s.layoutMode === "stretch" || s.layoutMode === "auto") {
        state.layoutMode = s.layoutMode;
      }
      if (s.gridMode === "auto" || s.gridMode === "custom") state.gridMode = s.gridMode;
      if (Number.isFinite(s.customCols)) state.customCols = s.customCols | 0;
      if (Number.isFinite(s.customRows)) state.customRows = s.customRows | 0;
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
          layoutMode: state.layoutMode,
          gridMode: state.gridMode,
          customCols: state.customCols,
          customRows: state.customRows,
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

    const col = state.layoutMode === "stretch" ? Math.floor(x / state.cellW) : Math.floor(x / state.cellSizeCss);
    const row = state.layoutMode === "stretch" ? Math.floor(y / state.cellH) : Math.floor(y / state.cellSizeCss);
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

  function setActiveModeUI() {
    if (!layoutModesEl) return;
    const btns = layoutModesEl.querySelectorAll("[data-mode]");
    for (const b of btns) {
      const mode = b.getAttribute("data-mode");
      const active = mode === state.layoutMode;
      b.dataset.active = active ? "true" : "false";
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.setAttribute("tabindex", active ? "0" : "-1");
    }
  }

  function setLayoutMode(mode) {
    if (mode !== "fit" && mode !== "fill" && mode !== "stretch" && mode !== "auto") return;
    state.layoutMode = mode;
    persistSettings();
    setActiveModeUI();
    onResize();
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

    layoutModesEl?.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const mode = t.getAttribute("data-mode");
      if (!mode) return;
      setLayoutMode(mode);
    });

    function parseGridInputs() {
      const cols = Number.parseInt(gridColsEl?.value || "", 10);
      const rows = Number.parseInt(gridRowsEl?.value || "", 10);
      return { cols, rows };
    }

    function maybeAutoFillOther(changed) {
      const cols = Number.parseInt(gridColsEl?.value || "", 10);
      const rows = Number.parseInt(gridRowsEl?.value || "", 10);

      if (changed === "cols" && Number.isFinite(cols) && cols > 0 && TOTAL % cols === 0) {
        gridRowsEl.value = String(TOTAL / cols);
      } else if (changed === "rows" && Number.isFinite(rows) && rows > 0 && TOTAL % rows === 0) {
        gridColsEl.value = String(TOTAL / rows);
      }
    }

    gridColsEl?.addEventListener("input", () => {
      setGridError("");
      maybeAutoFillOther("cols");
    });
    gridRowsEl?.addEventListener("input", () => {
      setGridError("");
      maybeAutoFillOther("rows");
    });

    applyGridBtn?.addEventListener("click", () => {
      const { cols, rows } = parseGridInputs();
      if (!isValidGrid(cols, rows)) {
        setGridError("Нужно, чтобы cols×rows = 86400 и оба числа были > 0.");
        return;
      }
      state.gridMode = "custom";
      state.customCols = cols;
      state.customRows = rows;
      persistSettings();
      setGridError("");
      onResize();
    });

    autoGridBtn?.addEventListener("click", () => {
      state.gridMode = "auto";
      persistSettings();
      setGridError("");
      onResize();
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
    setActiveModeUI();
    updateGridUI();

    bindUI();
    initFilledFromMode();
    tick();
  }

  init();
})();
