// Web shell (WP-B4): drives the editor_core.wasm component in the browser.
//
// Rendering runs in a POOL of Web Workers (render-worker.js). Worker 0 is
// authoritative — it holds the document + selection and handles every event and
// hit-test. The whole pool rasterizes the document, so the crisp "settle" frame
// is split into tiles rendered in PARALLEL across cores. The main thread owns
// the camera, input, panels and canvas, and never blocks. Two canvas layers:
// #cv is the document — rendered at FULL resolution while interacting via the
// engine's cached render() (the WP-C3 pixmap cache re-projects the full-res
// pixels on pan/zoom, so there is no resolution drop while moving), and as crisp
// parallel tiles when settled; #overlay is the always-crisp selection box/handles.
// Chrome follows the imported "Penna Editor" design.

import { listRecents, rememberDoc, recentBytes, forgetDoc, thumbUrl, relTime, saveDraft, loadDraft, clearDraft } from "./recents.js";

const $ = (id) => document.getElementById(id);
const cv = $("cv"), ctx = cv.getContext("2d", { alpha: true });
const overlay = $("overlay"), octx = overlay.getContext("2d", { alpha: true });
const fpsEl = $("fps");
// Double-buffered crisp document buffer: `off` is what blit() presents; a tiled
// settle renders into `back` and we swap only when it's COMPLETE, so the
// presented buffer is never shown half-rendered (that caused tearing on slow
// devices, where the tile fill is visibly progressive).
let off = document.createElement("canvas"), offCtx = off.getContext("2d", { alpha: true });
let back = document.createElement("canvas"), backCtx = back.getContext("2d", { alpha: true });
const errEl = $("err");

const MIN_SCALE = 1e-4, MAX_SCALE = 1e6, ZOOM_STEP = 1.0015, BTN_ZOOM = 1.3;
// Frames render at the true device resolution (cssPx × DPR, DPR capped at
// MAX_DPR) so the backing store matches the display 1:1 — no browser upscaling,
// no fuzziness. CRISP_MAX_PX is only a safety ceiling for very large windows
// (re-projection makes pan/zoom cost-independent of resolution, and the settle
// is parallel-tiled, so this can be generous). ~IDLE_MS after a gesture settles.
const CRISP_MAX_PX = 3200, IDLE_MS = 180, MAX_DPR = 2;
const TILE_PX = 384;               // settle tile size (preemption granularity)

let camera = null;                 // { cx, cy, scale } — scale = CSS px per world unit
let bounds = { x: 0, y: 0, width: 100, height: 100 };
let docInfo = null;                // document-info (physical size + display unit)
let tool = "select";
let alignRef = "page";             // Align tab: align relative to "page" or "selection"
let loaded = false;
let panning = false, lastPan = null, dragging = false;
// Live drag preview (Inkscape-style). Both modes composite over a captured
// background (doc minus selection) so the rest of the document never re-renders:
//  • dragSprite — a MOVE: slide the cached selection sprite to the cursor (GPU
//    only, no engine render per frame).
//  • liveEdit — a RESHAPE (scale/rotate/node/gradient): the selection changes
//    shape, so re-render just its sprite + the overlay each frame over the bg.
// `capturing` = the brief async setup after the down.
let dragSprite = null, liveEdit = null, capturing = false;
let lastTap = null;                // {t,x,y} of the last canvas tap (double-tap detect)
let lassoMode = false;             // rail "lasso": freehand polygon selection
let lasso = null;                  // {pts:[{x,y}]} while a lasso drag is in progress
// Draw the in-progress freehand lasso path onto the overlay (client-side; the next
// overlay render replaces it). Overlay backing is CSS-sized, like surface coords.
function drawLasso() {
  if (!lasso) return;
  const s = overlaySize();
  if (overlay.width !== s.width || overlay.height !== s.height) { overlay.width = s.width; overlay.height = s.height; }
  overlay.style.transform = "none";
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.save();
  octx.strokeStyle = "#4C8DFF"; octx.lineWidth = 1.5; octx.setLineDash([5, 4]);
  octx.beginPath();
  lasso.pts.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
  octx.stroke(); octx.restore();
  overlayClear = false;
}
let propTab = "fill";              // properties panel: "fill" | "stroke" | "style"
// The rail selection is tracked separately from the engine tool, because the
// design's rail has buttons (lasso, hand, dropper) that map onto the engine's
// "select" tool plus a client-side mode rather than a distinct engine tool.
let railTool = "select";           // which rail button is lit
let nodeRetype = false;            // node tool: retype mode (tap a node to cycle its type)
let handMode = false;              // hand tool: left-drag pans the canvas
let pickMode = false;              // eyedropper: next canvas click samples a colour
let penOnly = false;               // pen-only input (touch): a finger pans, only the stylus drives tools
let hasOverlay = false;            // is there anything for the overlay layer to draw?

const fail = (e) => {
  errEl.style.display = "block";
  // Show the message first — Firefox stacks omit it, which otherwise hid the real
  // error behind the RPC dispatch line. A stale cached worker (after a rebuild)
  // surfaces here as "… is not a function"; hard-reload to clear it.
  const msg = (e && e.message) ? e.message : String(e);
  const stack = (e && e.stack) ? e.stack : "";
  errEl.textContent = "Web shell error:\n\n" + msg + (stack && !stack.includes(msg) ? "\n\n" + stack : "");
  console.error(e);
};

// ---- worker pool + RPC ------------------------------------------------------
const POOL_N = (() => {
  const o = parseInt(new URLSearchParams(location.search).get("pool") || "", 10);   // ?pool=N override (debug)
  return o > 0 ? o : Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
})();
const pool = [];
for (let i = 0; i < POOL_N; i++) pool.push(new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" }));
const w0 = pool[0];                // authoritative instance
let rpcId = 0;
const pending = new Map();
let readyN = 0, markReady;
const ready = new Promise((r) => { markReady = r; });
for (const w of pool) {
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") { if (++readyN === pool.length) markReady(); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error((p.method ? p.method + ": " : "") + m.error));
  };
  w.onerror = (e) => fail(new Error(e.message || "worker error"));
}
function call(w, method, args, transfer) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    w.postMessage({ id, method, args }, transfer || []);
  });
}
const call0 = (method, args, transfer) => call(w0, method, args, transfer);

// Keep the pool's document copies in sync with worker 0 — but lazily: only
// re-broadcast before a settle when the doc actually changed. Pan/zoom (the hot
// path) mutate nothing, so they never trigger a resync.
let docDirty = true;
const markDocDirty = () => { docDirty = true; setUnsaved(true); scheduleAutosave(); };
// The "unsaved changes" state — the dot in the doc pill + a flag the home button
// checks so it can warn before discarding edits.
let unsaved = false;
function setUnsaved(on) { unsaved = on; const d = $("unsavedDot"); if (d) d.hidden = !on; }

// ---- autosave (recovery draft) ---------------------------------------------
// A browser can't silently write to the user's disk, so the web shell's autosave
// is a recovery DRAFT: a debounced snapshot to IndexedDB after edits settle, so
// unsaved work survives a crash / accidental reload (offered back on next boot).
// Explicit Save (which downloads the file) clears it.
const AUTOSAVE_MS = 2000;
let autosaveTimer = null;
function scheduleAutosave() {
  if (!loaded) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { runAutosave().catch(() => {}); }, AUTOSAVE_MS);
}
async function runAutosave() {
  if (!loaded || !unsaved) return;                  // nothing new since last save
  const bytes = await call0("save");
  if (!bytes || bytes.length === 0) return;         // never store a 0-byte draft
  await saveDraft({ name: $("docname").textContent || "document.svg", bytes });
}
async function ensurePool() {
  if (pool.length < 2 || !docDirty) return;
  docDirty = false;
  const bytes = await call0("save");
  await Promise.all(pool.slice(1).map((w) => {
    const copy = bytes.slice();                  // each instance needs its own buffer
    return call(w, "load", { bytes: copy }, [copy.buffer]);
  }));
}

// ---- camera (scale = CSS px per world unit) ---------------------------------
const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const cssW = () => cv.clientWidth || 1;
const cssH = () => cv.clientHeight || 1;
function fit() {
  const bw = Math.max(bounds.width, 1e-6), bh = Math.max(bounds.height, 1e-6);
  camera = {
    cx: bounds.x + bounds.width / 2,
    cy: bounds.y + bounds.height / 2,
    scale: clampScale(Math.min(cssW() / bw, cssH() / bh) * 0.9),
  };
}
function viewport() {
  const vw = cssW() / camera.scale, vh = cssH() / camera.scale;
  return { x: camera.cx - vw / 2, y: camera.cy - vh / 2, width: vw, height: vh };
}
function zoomAt(px, py, factor) {        // px,py in CSS pixels
  const fx = px / cssW() - 0.5, fy = py / cssH() - 0.5;
  const vp = viewport();
  const wx = camera.cx + fx * vp.width, wy = camera.cy + fy * vp.height;
  camera.scale = clampScale(camera.scale * factor);
  const nvp = viewport();
  camera.cx = wx - fx * nvp.width;
  camera.cy = wy - fy * nvp.height;
}
const dprCap = () => Math.min(window.devicePixelRatio || 1, MAX_DPR);

// Position the white page backdrop (#page) over the document's world bounds, so a
// blank / transparent document is visible against the dark canvas (Inkscape-style
// page on grey). Tracks the camera; hidden until a document is loaded.
function updatePage() {
  const pg = $("page");
  if (!pg) return;
  if (!loaded || !camera || !bounds || !(bounds.width > 0)) { pg.style.display = "none"; return; }
  const vp = viewport();
  pg.style.display = "block";
  pg.style.background = (docInfo && docInfo.pageColor) || "#fff";   // page background colour
  pg.style.left   = ((bounds.x - vp.x) / vp.width  * cssW()) + "px";
  pg.style.top    = ((bounds.y - vp.y) / vp.height * cssH()) + "px";
  pg.style.width  = (bounds.width  / vp.width  * cssW()) + "px";
  pg.style.height = (bounds.height / vp.height * cssH()) + "px";
  updateArtboard();
}

// The "Artboard … · W×H" label floats just above the page rect (design).
function updateArtboard() {
  const ab = $("artboard"); if (!ab) return;
  if (!loaded || !camera || !(bounds.width > 0)) { ab.style.display = "none"; return; }
  const vp = viewport();
  const left = (bounds.x - vp.x) / vp.width * cssW();
  const top = (bounds.y - vp.y) / vp.height * cssH();
  ab.style.display = "flex";
  ab.style.left = left + "px";
  ab.style.top = Math.max(2, top - 22) + "px";
  $("abName").textContent = ($("docname").textContent || "Artboard").replace(/\.svg$/i, "");
  if (docInfo) {
    const u = docInfo.displayUnit || "px";
    // document-info width-px is CSS px; for non-px units show the viewBox extent.
    const vb = docInfo.viewBox || {};
    $("abDim").textContent = u === "px"
      ? `${Math.round(docInfo.widthPx)} × ${Math.round(docInfo.heightPx)} px`
      : `${Math.round(vb.width || docInfo.widthPx)} × ${Math.round(vb.height || docInfo.heightPx)} ${u}`;
  } else {
    $("abDim").textContent = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
  }
}

// ---- render loop ------------------------------------------------------------
// The crisp document is kept at FULL resolution in an offscreen buffer (`off`)
// rendered for `crispVP` (the viewport ± a margin). Moving the camera RE-PROJECTS
// that buffer with a GPU `drawImage` — instant, full-resolution, no drop — while
// a coalesced parallel tiled render refreshes `off` for the latest view in the
// background. An object drag (camera fixed, document changed) instead uses the
// engine's cached render() so C5 re-rasterizes only the moved element. One render
// is in flight at a time (coalescing); `inputSeq` lets a new gesture preempt.
const MARGIN = 0.25;               // over-render fraction so small pans stay covered
let interacting = false, idleTimer = 0;
let busy = false, dirty = false, inputSeq = 0;
let firstPaint = null;
let camOnly = false;               // is the pending work a pure camera move?
let crispVP = null, crispReady = false; // world rect `off` holds, and whether it's valid

const expand = (vp, m) => ({ x: vp.x - vp.width * m, y: vp.y - vp.height * m, width: vp.width * (1 + 2 * m), height: vp.height * (1 + 2 * m) });

// On-screen FPS / frame-time counter (top-right of the canvas). Called at each
// present; the frame rate comes from the interval between consecutive frames,
// counting only fast back-to-back frames (an interaction) so idle gaps don't
// skew it. `workMs` is the time spent producing that frame. Both are smoothed.
let _lastFrameT = 0, _fps = 0, _frameMs = 0;
function markFrame(workMs) {
  const now = performance.now();
  if (_lastFrameT) {
    const dt = now - _lastFrameT;
    if (dt > 0 && dt < 500) _fps = _fps ? _fps * 0.85 + (1000 / dt) * 0.15 : 1000 / dt;
  }
  _lastFrameT = now;
  if (workMs != null) _frameMs = _frameMs ? _frameMs * 0.85 + workMs * 0.15 : workMs;
  if (!_fps) return;
  fpsEl.style.display = "block";
  fpsEl.textContent = `${Math.round(_fps)} fps · ${_frameMs.toFixed(1)} ms`;
  fpsEl.style.color = _fps >= 45 ? "#44dd55" : _fps >= 24 ? "#e0c040" : "#e06050";
}

// Re-project the crisp buffer onto #cv for the current viewport (instant, GPU).
function blit() {
  if (!crispReady) return;
  const t0 = performance.now();
  const s = crispSize(), vp = viewport();
  if (cv.width !== s.width || cv.height !== s.height) { cv.width = s.width; cv.height = s.height; }
  const sx = ((vp.x - crispVP.x) / crispVP.width) * off.width;
  const sy = ((vp.y - crispVP.y) / crispVP.height) * off.height;
  const sw = (vp.width / crispVP.width) * off.width;
  const sh = (vp.height / crispVP.height) * off.height;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(off, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  updatePage();
  reprojectOverlay();
  markFrame(performance.now() - t0);
  if (window.__dbg) window.__dbg.push({ t: performance.now(), w: cv.width, kind: "r" });
  if (firstPaint) { firstPaint(); firstPaint = null; }
}

// The overlay (handles) is rendered crisply for `overlayVP`. On a pan/zoom the
// document re-projects instantly via `blit`; mirror that for the overlay with a
// CSS transform so the handles track the document live (origin top-left) instead
// of lagging until the gesture settles. `drawOverlay` resets the transform and
// updates `overlayVP` when it re-renders crisply on settle.
let overlayVP = null;
function reprojectOverlay() {
  if (!overlayVP) { overlay.style.transform = "none"; return; }
  const vp = viewport();
  const s = overlayVP.width / vp.width;            // uniform (aspect preserved)
  const bx = cssW() / vp.width * (overlayVP.x - vp.x);
  const by = cssH() / vp.height * (overlayVP.y - vp.y);
  overlay.style.transform = `translate(${bx}px, ${by}px) scale(${s})`;
}

// Camera move (pan/zoom): re-project instantly, then refresh `off` in the
// background. Document edit/settle: a real render (no instant re-project).
function requestRenderCam() { camOnly = true; inputSeq++; dirty = true; markInteracting(); blit(); pump(); }
function requestRender() { camOnly = false; inputSeq++; dirty = true; pump(); }

async function pump() {
  if (busy || !loaded || !camera) return;
  busy = true;
  try {
    while (dirty) {
      dirty = false;
      const gen = inputSeq;
      updateZoom();
      if (!interacting) { await drawDocTiled(gen); await drawOverlay(gen); }      // settle
      else if (camOnly) { await drawDocTiled(gen); await drawOverlay(gen); }      // pan/zoom: refresh `off` + handles (CSS reproject in blit tracks between these)
      else { clearOverlay(); await drawDocInteractive(gen); }                     // drag: C5-incremental
    }
  } catch (e) { fail(e); } finally { busy = false; }
}
function markInteracting() {
  interacting = true;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { interacting = false; requestRender(); }, IDLE_MS);
}
const stale = (gen) => gen !== inputSeq;
function putFrame(c, x, y, f) {
  c.putImageData(new ImageData(new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, f.data.byteLength), f.width, f.height), x, y);
}
function crispSize() {
  const dpr = dprCap();
  let W = Math.round(cssW() * dpr), H = Math.round(cssH() * dpr);
  const q = Math.min(1, CRISP_MAX_PX / Math.max(W, H));
  return { width: Math.max(1, Math.round(W * q)), height: Math.max(1, Math.round(H * q)) };
}
// The overlay (selection box / node handles) is drawn at fixed PIXEL sizes by the
// engine, so render it at CSS resolution — not the hi-DPI crisp size — or the
// handles shrink by the device-pixel-ratio (tiny on hi-DPI screens).
function overlaySize() {
  return { width: Math.max(1, Math.round(cssW())), height: Math.max(1, Math.round(cssH())) };
}

// Crisp overlay layer, rendered only on settle (not per interaction frame).
let overlayClear = true;
function clearOverlay() {
  if (!overlayClear) { octx.clearRect(0, 0, overlay.width, overlay.height); overlayClear = true; }
}
// Render the overlay layer (#overlay) from the engine's ACTUAL state — always,
// not gated on the `hasOverlay` hint (which is set asynchronously from
// document-tree and would be stale at render time, leaving the handles missing on
// the tiled path). The engine returns a transparent buffer when there's nothing to
// draw, so this both shows and clears the handles correctly.
async function drawOverlay(gen) {
  const s = overlaySize(), vpUsed = viewport();
  try {
    const f = await call0("renderOverlay", { viewport: vpUsed, size: s });
    if (stale(gen)) return;
    if (overlay.width !== f.width || overlay.height !== f.height) { overlay.width = f.width; overlay.height = f.height; }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    putFrame(octx, 0, 0, f);
    overlayClear = false;
    overlay.style.transform = "none"; overlayVP = vpUsed;   // crisp again at this viewport
  } catch (e) { fail(e); }
}

// Interaction: a full-resolution cached render() on worker 0. The C3 pixmap
// cache re-projects its full-res pixels for pan/zoom within the margin (cheap,
// crisp) and C5 re-rasterizes only the edited element on a drag — so moving stays
// at full resolution and stays fast.
async function drawDocInteractive(gen) {
  const t0 = performance.now();
  const s = crispSize();
  const f = await call0("render", { viewport: viewport(), size: s, maxDownscale: 1 });
  if (stale(gen)) return;
  if (cv.width !== f.width || cv.height !== f.height) { cv.width = f.width; cv.height = f.height; }
  putFrame(ctx, 0, 0, f);
  markFrame(performance.now() - t0);
  if (window.__dbg) window.__dbg.push({ t: performance.now(), w: f.width, kind: "i" });
  if (firstPaint) { firstPaint(); firstPaint = null; }
}

// Render the document at full resolution for the viewport ± a margin into `off`,
// split into tiles rendered in PARALLEL across the worker pool. Updates the crisp
// buffer (`off`/`crispVP`) and re-projects it onto #cv. Used both for the settle
// frame and to refresh the buffer while panning/zooming (the instant feedback
// each input is the GPU `blit`; this fills in fresh crisp pixels behind it).
async function drawDocTiled(gen) {
  await ensurePool();
  if (stale(gen)) return;
  const t0 = performance.now();
  const cs = crispSize();
  const W = Math.round(cs.width * (1 + 2 * MARGIN)), H = Math.round(cs.height * (1 + 2 * MARGIN));
  const mvp = expand(viewport(), MARGIN);          // margined world rect this buffer covers
  // Render into the BACK buffer; the presented `off` stays untouched (and keeps
  // blit()-ing consistently) until this frame completes and we swap.
  if (back.width !== W || back.height !== H) { back.width = W; back.height = H; }

  const tiles = [];
  for (let y = 0; y < H; y += TILE_PX) for (let x = 0; x < W; x += TILE_PX)
    tiles.push({ x, y, tw: Math.min(TILE_PX, W - x), th: Math.min(TILE_PX, H - y) });
  const subVP = (t) => ({
    x: mvp.x + (t.x / W) * mvp.width, y: mvp.y + (t.y / H) * mvp.height,
    width: (t.tw / W) * mvp.width, height: (t.th / H) * mvp.height,
  });

  let nextTile = 0;
  const workerLoop = async (w) => {
    while (!stale(gen)) {
      const i = nextTile++;
      if (i >= tiles.length) return;
      const t = tiles[i];
      const f = await call(w, "renderTile", { viewport: subVP(t), size: { width: t.tw, height: t.th } });
      if (stale(gen)) return;
      backCtx.putImageData(new ImageData(new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, f.data.byteLength), f.width, f.height), t.x, t.y);
    }
  };
  await Promise.all(pool.map(workerLoop));
  if (stale(gen)) return;                          // a gesture resumed mid-render — discard the back buffer
  // Atomically swap the freshly-completed back buffer in as the presented one.
  [off, back] = [back, off];
  [offCtx, backCtx] = [backCtx, offCtx];
  crispVP = mvp; crispReady = true;
  blit();                                          // re-project the fresh buffer for the current view
  if (window.__dbg) window.__dbg.push({ t: performance.now(), w: cv.width, kind: "s", ms: Math.round(performance.now() - t0), tiles: tiles.length });
}

function updateZoom() {
  const z = Math.round(camera.scale * 100) + "%";
  $("zoomVal").textContent = z;
  $("zoomPill").textContent = z;
  updatePage();
}
function refreshOverlayFlag(selected) {
  hasOverlay = selected || tool !== "select" || dragging || panning;
}

// ---- pointer → CSS-pixel surface coords ------------------------------------
function surface(e) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const mods = (e) => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
const pointerEvent = (phase, e, button) => ({ phase, position: surface(e), button, scrollY: 0, modifiers: mods(e) });
// A hovering stylus (e.g. the Samsung S Pen) fires pointer events with NO contact
// (pressure 0, no buttons). Those must never drive tool input — otherwise the pen
// tool drops nodes "without pressing" as the pen approaches the screen.
const penHover = (e) => e.pointerType === "pen" && e.pressure === 0 && e.buttons === 0;
// Worker 0 maps pointer coords via the last set-view; keep it at CSS-pixel size.
const sendView = () => call0("setView", { viewport: viewport(), size: { width: Math.round(cssW()), height: Math.round(cssH()) } });

function forward(method, ev, structural) {
  sendView();
  call(w0, method, { ev }).then((dirty) => {
    if (method === "handleKey" || (ev.phase === "up")) markDocDirty();   // may have edited
    if (dirty && dirty.full) requestRender();
    if (structural) refreshPanels();
  }).catch(fail);
}

// ---- live drag preview (sprite) --------------------------------------------
function frameToCanvas(f) {
  const c = document.createElement("canvas");
  c.width = f.width; c.height = f.height;
  c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, f.data.byteLength), f.width, f.height), 0, 0);
  return c;
}
// Is the sprite non-empty (something selected)? Strided alpha scan — cheap, run once.
function spriteHasPixels(f) {
  const d = f.data;
  for (let i = 3; i < d.length; i += 64) if (d[i] !== 0) return true;
  return false;
}
function compositeSprite(e) {
  const d = dragSprite;
  if (!d) return;
  d.e = e;                                       // remember the latest position (for the bg swap)
  const t0 = performance.now();
  if (cv.width !== d.w || cv.height !== d.h) { cv.width = d.w; cv.height = d.h; }
  const k = cv.width / cssW();                 // CSS px → backing-store px
  const s = surface(e);
  const dx = (s.x - d.startSurf.x) * k, dy = (s.y - d.startSurf.y) * k;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(d.bg, 0, 0);                    // elements below the selection
  ctx.drawImage(d.sprite, dx, dy);             // moving selection, offset to cursor
  if (d.above) ctx.drawImage(d.above, 0, 0);   // elements above it (keep z-order)
  markFrame(performance.now() - t0);
}
// Reshape gestures (scale/rotate/node/gradient) re-render the selection each
// frame over the cached bg. Coalesced: one engine round-trip in flight at a
// time; the latest pending move runs next.
let leBusy = false, lePending = null;
function compositeLiveEdit(sp) {
  const d = liveEdit;
  if (cv.width !== d.w || cv.height !== d.h) { cv.width = d.w; cv.height = d.h; }
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(d.bg, 0, 0);          // elements below the selection
  ctx.drawImage(frameToCanvas(sp), 0, 0); // the reshaped selection, in place
  if (d.above) ctx.drawImage(d.above, 0, 0); // elements above it (keep z-order)
  if (window.__dbg) window.__dbg.push({ t: performance.now(), w: cv.width, kind: "le" });
}
async function liveEditMove(e) {
  lePending = e;
  if (leBusy) return;
  leBusy = true;
  try {
    while (lePending && liveEdit) {
      const ev = lePending; lePending = null;
      const size = liveEdit.size, vp = viewport();
      const t0 = performance.now();
      sendView();
      await call0("handlePointer", { ev: pointerEvent("moved", ev, undefined) });
      if (!liveEdit) break;
      const [sp, ov] = await Promise.all([
        call0("renderSelectionSprite", { viewport: vp, size }),
        hasOverlay ? call0("renderOverlay", { viewport: vp, size: overlaySize() }) : Promise.resolve(null),
      ]);
      if (!liveEdit) break;
      compositeLiveEdit(sp);
      markFrame(performance.now() - t0);
      if (ov) {
        if (overlay.width !== ov.width || overlay.height !== ov.height) { overlay.width = ov.width; overlay.height = ov.height; }
        octx.clearRect(0, 0, overlay.width, overlay.height);
        putFrame(octx, 0, 0, ov);
        overlayClear = false;
        overlay.style.transform = "none"; overlayVP = vp;
      }
    }
  } catch (err) { fail(err); } finally { leBusy = false; }
}

// Left-press with the select/node/gradient tools may begin a drag. Do the down,
// ask the engine which gesture it armed, then capture the background once. A MOVE
// slides the cached sprite (no per-frame render); a RESHAPE re-renders the
// selection each frame; anything else (click / rubber-band / one-shot edit)
// falls back to a normal render.
// Snapshot the current canvas (cheap, GPU) — used as a provisional drag
// background so the drag starts instantly without waiting for the (slower)
// selection-excluded render.
function snapshotCanvas() {
  const c = document.createElement("canvas");
  c.width = cv.width; c.height = cv.height;
  c.getContext("2d").drawImage(cv, 0, 0);
  return c;
}
// Capture the drag background atomically: the document-minus-selection when
// un-occluded, or the below + above layers when occluded (so the shell composites
// below + sprite + above for correct z). Returning both together makes the swap
// atomic — no flicker from a late-arriving above-layer.
function bgLayers(occluded, vp, size) {
  if (!occluded) return call0("renderWithoutSelection", { viewport: vp, size }).then((bg) => ({ bg: frameToCanvas(bg) }));
  return Promise.all([
    call0("renderBelowSelection", { viewport: vp, size }),
    call0("renderAboveSelection", { viewport: vp, size }),
  ]).then(([bg, ab]) => ({ bg: frameToCanvas(bg), above: frameToCanvas(ab) }));
}
async function beginDrag(e) {
  capturing = true;
  clearTimeout(idleTimer); // no settle should fire mid-drag (the preview is live)
  try {
    sendView();
    const dirty = await call0("handlePointer", { ev: pointerEvent("down", e, "left") });
    // Await refreshPanels (it sets hasOverlay from the new selection) BEFORE
    // requestRender, so the settle's overlay render actually draws the handles —
    // otherwise the render runs with a stale hasOverlay and the handles only
    // appear on the next interaction.
    if (!dragging) { await refreshPanels(); if (dirty && dirty.full) requestRender(); return; }
    const kind = await call0("dragKind");
    if (!kind) { await refreshPanels(); requestRender(); return; } // no drag armed (click/rubber-band/edit)
    // If the selection is occluded (something is painted above it), composite an
    // extra "above" layer over the sprite so it keeps its z-position, with the
    // "below" layer as the background (so the above elements aren't double-drawn).
    // Un-occluded selections use the cheaper whole-document-minus-selection bg.
    const occluded = await call0("selectionOccluded");
    const size = crispSize(), vp = viewport();
    // Start the drag instantly: use a snapshot of the current canvas as a
    // provisional background (it still shows the selection at its origin) and
    // render the true selection-excluded background concurrently, swapping it in
    // when ready — which clears the brief origin "ghost". This keeps the drag
    // responsive even when the document render is slow (the worker's C5 cache is
    // cold, or it's a big document).
    const provisional = snapshotCanvas();
    clearOverlay();
    // The selection-excluded background can be slow (cold C5 cache / big doc), so
    // render the cheap pieces FIRST and start the drag, then fire the background
    // render and swap it in — worker 0 is single-threaded, so enqueuing the slow
    // render first would make the fast pieces wait behind it.
    if (kind === "move") {                        // translate: capture the sprite once
      const sp = await call0("renderSelectionSprite", { viewport: vp, size });
      if (!dragging) { await refreshPanels(); requestRender(); return; }
      if (spriteHasPixels(sp)) {
        dragSprite = { startSurf: surface(e), bg: provisional, sprite: frameToCanvas(sp), w: size.width, h: size.height, e };
        compositeSprite(e);
        // Swap in the true background (+ the above-layer when occluded) in ONE step
        // so the document never flickers (no frame with the above-elements missing).
        bgLayers(occluded, vp, size)
          .then((L) => { if (dragSprite) { dragSprite.bg = L.bg; if (L.above) dragSprite.above = L.above; compositeSprite(dragSprite.e); } }).catch(fail);
      } else { requestRender(); }
    } else {                                      // reshape: re-render the sprite each frame
      liveEdit = { bg: provisional, w: size.width, h: size.height, size };
      liveEditMove(e);                             // composites bg + sprite immediately
      bgLayers(occluded, vp, size)
        .then((L) => { if (liveEdit) { liveEdit.bg = L.bg; if (L.above) liveEdit.above = L.above; } }).catch(fail);
    }
    // Panels aren't in the critical path of showing the drag — refresh them after.
    refreshPanels();
  } catch (err) { fail(err); } finally { capturing = false; }
}

function wireCanvas() {
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  // Suppress the browser's middle-click autoscroll so middle-drag pans the canvas.
  cv.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  cv.addEventListener("pointerdown", (e) => {
    try {
      if (penHover(e)) return;                        // a hovering S Pen is not a press
      cv.setPointerCapture(e.pointerId);
      // Pen-only input: a finger pans/navigates instead of driving the tool — only
      // the stylus (pen) and mouse activate tools. Mirrors the tauri/Android fork.
      if (penOnly && e.pointerType === "touch") { panning = true; lastPan = surface(e); refreshOverlayFlag(hasOverlay); return; }
      if (e.button === 1) { e.preventDefault(); panning = true; lastPan = surface(e); refreshOverlayFlag(hasOverlay); return; } // middle-drag pan
      // Hand tool: a left-drag pans the canvas (same as a middle-drag).
      if (handMode && e.button === 0) { panning = true; lastPan = surface(e); refreshOverlayFlag(hasOverlay); return; }
      // Eyedropper: sample the pixel under the click, apply it as the active paint.
      if (pickMode && e.button === 0) { pickColorAt(e); return; }
      // Lasso tool: capture a freehand selection path (client-side); on release we
      // hand the polygon to the engine. A tap (no real drag) falls back to a click.
      if (lassoMode && e.button === 0) { lasso = { pts: [surface(e)] }; drawLasso(); return; }
      dragging = true;
      const btn = e.button === 2 ? "right" : "left";
      // Double-tap (no `dblclick` on touch): the engine routes by tool — node tool
      // inserts a node, select descends into a group, gradient adds a stop.
      if (btn === "left") {
        const p = surface(e);
        if (lastTap && e.timeStamp - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24) {
          lastTap = null; dragging = false;
          sendView();
          call0("enterGroup", { point: { x: p.x, y: p.y } })
            .then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail);
          return;
        }
        lastTap = { t: e.timeStamp, x: p.x, y: p.y };
      }
      // Node-type modifier on: a tap cycles the tapped node's type (a mutation,
      // not a drag) — forward down+up and re-render, skipping the live preview.
      if (btn === "left" && nodeRetype && tool === "node") {
        dragging = false;
        retypeTap(e);
        return;
      }
      // A left-press with an editing tool may begin a drag → set up a live
      // preview (beginDrag also does the down). Everything else forwards normally.
      if (btn === "left" && (tool === "select" || tool === "node" || tool === "gradient")) {
        beginDrag(e);
      } else {
        markInteracting();
        forward("handlePointer", pointerEvent("down", e, btn), true);
      }
    } catch (err) { fail(err); }
  });
  cv.addEventListener("pointermove", (e) => {
    try {
      if (penHover(e)) return;                        // ignore S Pen hover moves (no contact)
      if (lasso) { lasso.pts.push(surface(e)); drawLasso(); return; }
      if (panning) {
        const p = surface(e), vp = viewport();
        camera.cx -= (p.x - lastPan.x) * (vp.width / cssW());
        camera.cy -= (p.y - lastPan.y) * (vp.height / cssH());
        lastPan = p; requestRenderCam(); return;
      }
      if (capturing) return;                       // ignore moves while setting up the preview
      if (dragSprite) {                            // move: composite + sync the engine (no render)
        compositeSprite(e);
        sendView();
        call0("handlePointer", { ev: pointerEvent("moved", e, undefined) }).catch(fail);
        return;
      }
      if (liveEdit) { liveEditMove(e); return; }   // reshape: re-render the selection each frame
      markInteracting();
      forward("handlePointer", pointerEvent("moved", e, undefined), false);
    } catch (err) { fail(err); }
  });
  const endDrag = (e) => {
    try {
      // Finish a lasso: a real outline → polygon select; a tap → a normal click.
      if (lasso) {
        const pts = lasso.pts; lasso = null;
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const span = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
        sendView();
        if (pts.length >= 3 && span > 12) {
          call0("selectInPolygon", { points: pts.map((p) => ({ x: p.x, y: p.y })) })
            .then(() => { refreshPanels(); requestRender(); }).catch(fail);
        } else {
          call0("handlePointer", { ev: pointerEvent("down", e, "left") })
            .then(() => call0("handlePointer", { ev: pointerEvent("up", e, "left") }))
            .then(() => { refreshPanels(); requestRender(); }).catch(fail);
        }
        return;
      }
      if (panning) { panning = false; requestRenderCam(); return; }
      dragging = false;
      if (dragSprite || liveEdit) {                // commit the gesture, then a crisp re-render
        dragSprite = null; liveEdit = null; lePending = null;
        sendView();
        call0("handlePointer", { ev: pointerEvent("moved", e, undefined) })
          .then(() => call0("handlePointer", { ev: pointerEvent("up", e, "left") }))
          // Await refreshPanels (sets hasOverlay) before the render, and force a
          // settle: beginDrag cleared the idle timer, so without resetting
          // `interacting` a committed drag could leave it stuck true and the crisp
          // overlay (which sets overlayVP for zoom re-projection) would never render.
          .then(async () => { markDocDirty(); await refreshPanels(); clearTimeout(idleTimer); interacting = false; requestRender(); })
          .catch(fail);
        return;
      }
      forward("handlePointer", pointerEvent("up", e, "left"), true);
    } catch (err) { fail(err); }
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  cv.addEventListener("wheel", (e) => {
    try {
      e.preventDefault();
      const p = surface(e);
      zoomAt(p.x, p.y, Math.pow(ZOOM_STEP, -e.deltaY));
      requestRenderCam();
    } catch (err) { fail(err); }
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    try {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      // Ctrl+S = Save, Ctrl+Shift+S = Save as…
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (e.shiftKey) saveDocumentAs(); else saveDocument();
        return;
      }
      // Shift+Ctrl+D = Document properties (Inkscape's shortcut).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        openDocProps();
        return;
      }
      // Shift+Ctrl+C: object to path (Inkscape's shortcut). Handled in the shell
      // (the engine's key handler doesn't map it) — convert the selection.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        call0("toPath").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail);
        return;
      }
      const printable = e.key.length === 1;
      const editKey = ["Enter", "Backspace", "Delete", "Escape", "Tab", " ", "Home", "End"].includes(e.key) || e.key.startsWith("Arrow");
      const undoRedo = (e.ctrlKey || e.metaKey) && ["z", "y", "Z", "Y"].includes(e.key);
      if ((printable && !e.ctrlKey && !e.metaKey) || (editKey && !e.ctrlKey && !e.metaKey) || undoRedo) e.preventDefault();
      const text = printable ? e.key : undefined;
      call0("handleKey", { ev: { phase: "down", key: e.key, text, modifiers: mods(e) } })
        .then((dirty) => { markDocDirty(); if (dirty && dirty.full) { requestRender(); refreshPanels(); } })
        .catch(fail);
    } catch (err) { fail(err); }
  });

  new ResizeObserver(() => requestRender()).observe(cv);
}

// ---- tool rail -------------------------------------------------------------
// The design's rail (Select / Lasso / Node / Pen / Brush / Shape / Text /
// Dropper / Hand) is broader than the engine's tool enum. We track the lit rail
// button (`railTool`) separately and map it onto a real engine tool + a
// client-side mode: lasso/hand/dropper all drive the engine's "select" tool,
// "shape" fans out to rect/ellipse/star via a flyout, and brush has no engine
// support yet (its button is disabled).
const RAIL_LABELS = {
  select: "Select", lasso: "Multi-select", node: "Edit nodes", pen: "Pen",
  brush: "Brush", text: "Text", dropper: "Eyedropper", hand: "Hand",
  rect: "Rectangle", ellipse: "Ellipse", star: "Star",
};
let lastShape = "rect";            // which shape the combined Shape tool draws

function applyEngineTool(id) {
  tool = id;
  call0("setTool", { id }).then(() => { refreshOverlayFlag(hasOverlay); requestRender(); }).catch(fail);
}
function setRail(rail, opts = {}) {
  railTool = rail;
  handMode = rail === "hand";
  pickMode = rail === "dropper";
  lassoMode = rail === "lasso";
  let engineId = rail;
  if (rail === "lasso" || rail === "hand" || rail === "dropper") engineId = "select";
  else if (rail === "shape") engineId = opts.shape || lastShape;
  applyEngineTool(engineId);
  document.querySelectorAll(".tool[data-rail]").forEach((t) => t.classList.toggle("active", t.dataset.rail === rail));
  const label = rail === "shape" ? RAIL_LABELS[engineId] : RAIL_LABELS[rail];
  $("toolName").textContent = label || rail;
  cv.classList.toggle("cur-grab", handMode);
  cv.classList.toggle("cur-pick", pickMode);
  // The node-type modifier lives only in the node tool; leaving it turns the
  // mode off (the engine auto-clears too — keep the UI in sync).
  if (rail !== "node" && nodeRetype) setNodeRetype(false);
  updateCtxGroups();
}

// The floating toolbar is tool-contextual: the Select tool shows object actions
// (booleans / group / object-to-path), the Node tool shows node actions (type
// toggle / break / delete). Each `.ctxgroup` declares which engine tool it serves.
function updateCtxGroups() {
  document.querySelectorAll(".ctxbar .ctxgroup").forEach((g) => (g.hidden = g.dataset.tool !== tool));
}

// Node-type modifier (touch-first): toggle retype mode on the engine and light up
// the rail button. When on, a tap on a node cycles its type.
function setNodeRetype(on) {
  nodeRetype = on;
  $("nodeMod").classList.toggle("on", on);
  call0("setNodeRetype", { on }).catch(fail);
}

// A retype tap: send down+up to the engine (which cycles the tapped node's type
// and selects the path if needed), then re-render the document + refresh panels.
function retypeTap(e) {
  markInteracting();
  call0("handlePointer", { ev: pointerEvent("down", e, "left") })
    .then(() => call0("handlePointer", { ev: pointerEvent("up", e, "left") }))
    .then(() => { markDocDirty(); refreshPanels(); clearTimeout(idleTimer); interacting = false; requestRender(); })
    .catch(fail);
}

function wireRail() {
  const fly = $("shapeFlyout"), shapeBtn = $("shapeTool");
  const markFly = () => fly.querySelectorAll(".flyitem").forEach((i) => i.classList.toggle("active", i.dataset.tool === lastShape));
  for (const btn of document.querySelectorAll(".tool[data-rail]")) {
    if (btn.disabled) continue;
    const rail = btn.dataset.rail;
    btn.addEventListener("click", () => {
      try {
        if (rail === "shape") {
          setRail("shape");
          const r = btn.getBoundingClientRect();
          fly.style.left = (r.right + 8) + "px";
          fly.style.top = r.top + "px";
          fly.hidden = !fly.hidden;
          markFly();
          return;
        }
        fly.hidden = true;
        setRail(rail);
      } catch (err) { fail(err); }
    });
  }
  for (const item of fly.querySelectorAll(".flyitem")) {
    item.addEventListener("click", () => {
      try { lastShape = item.dataset.tool; setRail("shape", { shape: lastShape }); markFly(); fly.hidden = true; } catch (e) { fail(e); }
    });
  }
  document.addEventListener("pointerdown", (e) => {
    if (!fly.hidden && !fly.contains(e.target) && !shapeBtn.contains(e.target)) fly.hidden = true;
  });
  // Pen-only toggle (touch devices): not a tool — a sticky input mode.
  const pob = $("penOnlyBtn");
  if (pob) pob.addEventListener("click", () => { penOnly = !penOnly; pob.classList.toggle("on", penOnly); });
  setRail("select");
}

// Eyedropper: read the pixel under the click off the document canvas (not
// tainted — it's filled via putImageData) and apply it as the active paint.
const rgbToHex = (r, g, b) => "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
function pickColorAt(e) {
  try {
    const s = surface(e), k = cv.width / cssW();
    const x = Math.max(0, Math.min(cv.width - 1, Math.round(s.x * k)));
    const y = Math.max(0, Math.min(cv.height - 1, Math.round(s.y * k)));
    const px = ctx.getImageData(x, y, 1, 1).data;
    if (px[3] === 0) return;                          // transparent — nothing under the cursor
    applyActivePaint(rgbToHex(px[0], px[1], px[2]));
  } catch (err) { fail(err); }
}

// ---- layers panel ----------------------------------------------------------
const EYE_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_OFF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.1A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.6 4.3M6.2 7.3A17 17 0 0 0 2 12s3.5 6 10 6a10 10 0 0 0 3.6-.7"/></svg>';
const LOCK_ON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const LOCK_OFF = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-1.5"/></svg>';
const ICON_LAYER = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/></svg>';

async function refreshPanels() {
  let tree = [];
  try { tree = await call0("documentTree"); } catch { /* no doc */ }
  const sel = tree.find((n) => n.selected) || null;
  const selCount = tree.filter((n) => n.selected).length;
  refreshOverlayFlag(!!sel);
  renderLayers(tree);
  renderProps(sel, selCount);
  updateCtxBar(sel, selCount);
}

// The flat tree currently shown in the Layers panel (for drag-reorder maths).
let layerTree = [];
function rowAtPoint(host, cy) {
  for (const r of host.children) {
    const b = r.getBoundingClientRect();
    if (cy >= b.top && cy <= b.bottom) return r;
  }
  return null;
}
// Reorder `src` among its same-depth siblings to `tgt`'s position by issuing N
// raise/lower steps (the engine moves one step at a time).
async function reorderToward(src, tgt, isLayer) {
  const sibs = layerTree.filter((t) => t.isLayer === isLayer && t.depth === src.depth);
  const from = sibs.findIndex((t) => t.id === src.id);
  const to = sibs.findIndex((t) => t.id === tgt.id);
  if (from < 0 || to < 0 || from === to) return false;
  const op = to > from ? "raise-one" : "lower-one";       // later in doc order = higher z
  for (let i = 0; i < Math.abs(to - from); i++) {
    if (isLayer) await call0("reorderLayer", { id: src.id, op });
    else await call0("reorder", { op });
  }
  return true;
}
// object → layer: move into the layer; layer → layer / object → object: reorder
// among same-depth siblings (multi-step).
async function doLayerDrop(src, tgt) {
  try {
    if (!src.isLayer && tgt.isLayer) {
      await call0("selectNode", { node: src.id });
      await call0("moveToLayer", { layer: tgt.id });
    } else if (src.isLayer && tgt.isLayer) {
      if (!(await reorderToward(src, tgt, true))) return;
    } else if (!src.isLayer && !tgt.isLayer) {
      await call0("selectNode", { node: src.id });          // reorder acts on the selection
      if (!(await reorderToward(src, tgt, false))) return;
    } else return;
    markDocDirty(); requestRender(); await refreshPanels();
  } catch (e) { fail(e); }
}
// Tap the row body to select its node; drag the GRIP handle onto another row to
// reorder / promote (the list scrolls, so we can't drag from the whole row — the
// grip has touch-action:none). Pointer-based — HTML5 DnD doesn't fire on touch.
function wireRowInteract(row, n, host, grip) {
  let dx = 0, dy = 0, tapping = false;
  row.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, .grip")) return;
    tapping = true; dx = e.clientX; dy = e.clientY;
  });
  row.addEventListener("pointercancel", () => { tapping = false; });
  row.addEventListener("pointerup", (e) => {
    if (!tapping) return;
    tapping = false;
    if (e.target.closest("button, input, .grip")) return;
    if (Math.hypot(e.clientX - dx, e.clientY - dy) > 10) return;
    call0("selectNode", { node: n.id }).then(() => { requestRender(); refreshPanels(); }).catch(fail);
  });

  let dragging = false;
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragging = true; row.classList.add("dragging");
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    for (const r of host.children) r.classList.toggle("drop", false);
    const t = rowAtPoint(host, e.clientY);
    if (t && t !== row) t.classList.add("drop");
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    row.classList.remove("dragging");
    for (const r of host.children) r.classList.remove("drop");
    const t = rowAtPoint(host, e.clientY);
    if (t && t.__node && t.__node.id !== n.id) doLayerDrop(n, t.__node);
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

// The panel lists frontmost (topmost z) first — the opposite of paint/document
// order. The tree is a preorder DFS with `depth`; reverse SIBLINGS at each level
// while keeping every parent before its children (so the indentation still reads).
function frontFirst(flat) {
  let i = 0;
  const base = flat.length ? flat[0].depth : 0;
  const parse = (depth) => {
    const out = [];
    while (i < flat.length && flat[i].depth === depth) {
      const node = flat[i++];
      out.push({ node, children: parse(depth + 1) });
    }
    return out;
  };
  const roots = parse(base);
  const result = [];
  (function emit(nodes) {
    for (let k = nodes.length - 1; k >= 0; k--) { result.push(nodes[k].node); emit(nodes[k].children); }
  })(roots);
  return result;
}

function renderLayers(tree) {
  const host = $("layers");
  host.textContent = "";
  layerTree = tree;                                  // keep DOC order for reorder math
  if (!tree.length) { host.innerHTML = '<div class="empty">empty document</div>'; return; }
  for (const n of frontFirst(tree)) {                // display frontmost first
    const row = document.createElement("div");
    row.className = "row" + (n.selected ? " sel" : "");
    row.__node = n;
    row.dataset.nid = n.id;                          // stable id (for tests/debug)
    row.style.paddingLeft = (8 + n.depth * 16) + "px";
    if (!n.visible) row.style.opacity = "0.5";

    // Drag handle (reorder / promote); touch-action:none so it doesn't scroll.
    const grip = document.createElement("span");
    grip.className = "grip";
    grip.title = "Drag to reorder";
    grip.innerHTML = '<svg width="11" height="15" viewBox="0 0 11 15" fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="8" cy="3" r="1.3"/><circle cx="3" cy="7.5" r="1.3"/><circle cx="8" cy="7.5" r="1.3"/><circle cx="3" cy="12" r="1.3"/><circle cx="8" cy="12" r="1.3"/></svg>';
    row.appendChild(grip);

    // chip: a layer shows a layer glyph; an element shows its computed fill colour.
    const chip = document.createElement("span");
    if (n.isLayer) { chip.className = "chip layer"; chip.innerHTML = ICON_LAYER; }
    else {
      chip.className = "chip";
      chip.style.background = "#3a3d42";
      call0("computedStyle", { node: n.id, property: "fill" })
        .then((v) => { if (v && v !== "none") chip.style.background = v; }).catch(() => {});
    }
    row.appendChild(chip);

    const lbl = document.createElement("span");
    lbl.className = "lbl" + (!n.isLayer && !n.selected ? " dim" : "");
    lbl.textContent = n.label || n.tag;
    row.appendChild(lbl);

    // Persistent locked indicator (always visible, not just on hover) so it's
    // obvious a layer/object/path is locked. Hidden on hover so the .extra lock
    // toggle (layers) can take its place.
    if (n.locked) {
      row.classList.add("locked");
      const lk = document.createElement("span");
      lk.className = "lockbadge"; lk.title = "Locked"; lk.innerHTML = LOCK_ON;
      row.appendChild(lk);
    }

    // Layer-only controls (opacity + reorder / sublayer / delete), revealed on
    // hover so the row stays clean at rest (matching the design).
    if (n.isLayer) {
      const relayer = (method, args) =>
        call0(method, args).then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail);
      const extra = document.createElement("span");
      extra.className = "extra";

      const op = document.createElement("input");
      op.type = "range"; op.className = "lop"; op.min = "0"; op.max = "1"; op.step = "0.05"; op.value = "1";
      op.title = "Layer opacity";
      call0("computedStyle", { node: n.id, property: "opacity" })
        .then((v) => { const f = parseFloat(v); if (!Number.isNaN(f)) op.value = String(f); }).catch(() => {});
      op.addEventListener("click", (e) => e.stopPropagation());
      op.addEventListener("input", (e) => {
        e.stopPropagation();
        call0("setLayerOpacity", { id: n.id, opacity: parseFloat(op.value) })
          .then(() => { markDocDirty(); requestRender(); }).catch(fail);
      });
      extra.appendChild(op);

      for (const [glyph, title, method, args] of [
        ["↑", "Raise layer", "reorderLayer", { id: n.id, op: "raise-one" }],
        ["↓", "Lower layer", "reorderLayer", { id: n.id, op: "lower-one" }],
        ["+", "Add sublayer", "createSublayer", { parent: n.id, label: "Sublayer" }],
        ["✕", "Delete layer", "deleteLayer", { id: n.id }],
      ]) {
        const b = document.createElement("button");
        b.className = "mini tg";
        b.textContent = glyph;
        b.title = title;
        b.addEventListener("click", (e) => { e.stopPropagation(); relayer(method, args); });
        extra.appendChild(b);
      }
      row.appendChild(extra);
    }

    const lock = document.createElement("button");
    lock.className = "mini" + (n.locked ? " on" : "");
    lock.innerHTML = n.locked ? LOCK_ON : LOCK_OFF;
    lock.title = n.locked ? "Unlock" : "Lock";
    lock.addEventListener("click", (e) => {
      e.stopPropagation();
      call0("setLayerLocked", { id: n.id, locked: !n.locked }).then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail);
    });
    row.appendChild(lock);

    const eye = document.createElement("button");
    eye.className = "mini" + (n.visible ? "" : " on");
    eye.innerHTML = n.visible ? EYE_OPEN : EYE_OFF;
    eye.title = n.visible ? "Hide" : "Show";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      call0("setLayerVisible", { id: n.id, visible: !n.visible }).then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail);
    });
    row.appendChild(eye);

    wireRowInteract(row, n, host, grip);
    host.appendChild(row);
  }
}

// ---- properties panel ------------------------------------------------------
// HSV colour model behind the picker (ported from the Penna design's support.js).
const SWATCHES = ['#2DD4BF','#4C8DFF','#7C5CFF','#FF6B5B','#FFD166','#6366F1','#22C55E','#EC4899','#0EA5E9','#F59E0B','#FFFFFF','#161719'];
const paint = { fill: { h: 230, s: 60, v: 96, a: 100 }, stroke: { h: 220, s: 6, v: 55, a: 100 } };
let selNode = null;                // the current single selection (or null)
function h2r(h, s, v) {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const hx = (a) => "#" + a.map((n) => n.toString(16).padStart(2, "0")).join("");
function hex2hsv(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = 60 * (((g - b) / d) % 6); else if (mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4); }
  if (h < 0) h += 360;
  return { h: Math.round(h), s: Math.round(mx ? d / mx * 100 : 0), v: Math.round(mx * 100) };
}
const activeKey = () => (propTab === "stroke" ? "stroke" : "fill");
const activePaint = () => paint[activeKey()];
const activeHex = () => hx(h2r(activePaint().h, activePaint().s, activePaint().v));

// Push the active paint's colour to the engine selection (+ the fill chip).
function pushColor() {
  const k = activeKey(), hexv = activeHex();
  if (k === "fill") {
    $("fillchip").style.background = hexv;
    call0("setFill", { color: hexv }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail);
  } else {
    call0("setStroke", { color: hexv }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail);
  }
}
function pushAlpha() {
  const k = activeKey(), a = activePaint().a / 100;
  const prop = k === "fill" ? "fill-opacity" : "stroke-opacity";
  call0("setStyleProperty", { property: prop, value: String(a) }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail);
}
// Apply an externally-chosen colour (eyedropper / swatch / hex field) to the
// active tab and refresh the picker UI in place.
function applyActivePaint(hexv) {
  const k = activeKey();
  paint[k] = { ...paint[k], ...hex2hsv(hexv) };
  pushColor();
  syncPicker();
}

// Reflect the active paint state onto the picker DOM (no rebuild).
function syncPicker() {
  const sv = $("sv"); if (!sv) return;             // stroke-style tab: no picker
  const p = activePaint();
  sv.style.background = hx(h2r(p.h, 100, 100));
  $("svDot").style.left = p.s + "%"; $("svDot").style.top = (100 - p.v) + "%";
  $("hueDot").style.left = (p.h / 360 * 100) + "%";
  $("alphaDot").style.left = p.a + "%";
  const rgb = h2r(p.h, p.s, p.v);
  $("alphaFill").style.background = `linear-gradient(90deg,rgba(${rgb[0]},${rgb[1]},${rgb[2]},0),rgb(${rgb[0]},${rgb[1]},${rgb[2]}))`;
  if (document.activeElement !== $("hexField")) $("hexField").value = activeHex().slice(1).toUpperCase();
  if (document.activeElement !== $("opField")) $("opField").value = String(p.a);
  $("swatches") && $("swatches").querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.c.toLowerCase() === activeHex().toLowerCase()));
}

// Dash-array patterns for the stroke-style segmented control.
const DASH = { solid: "none", dashed: "6,4", dotted: "1,4", dashdot: "6,4,1,4" };

function renderProps(sel, selCount = 0) {
  selNode = sel;
  const body = $("propBody");
  const isText = sel && (sel.tag === "text" || sel.tag === "tspan");
  const strokeTab = propTab === "stroke";

  if (propTab === "style") {
    body.innerHTML = `
      <div class="seclabel">Width</div>
      <div class="wrow">
        <button class="stepbtn" id="wDec"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
        <div class="wfield"><input id="wInput" value="2" /><span class="u">px</span></div>
        <button class="stepbtn" id="wInc"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <div class="slider" id="wSlider"><div class="fill" id="wFill"></div><div class="knob" id="wKnob"></div></div>
      <div class="seclabel">Join</div>
      <div class="seg" id="joinSeg">
        <button data-join="miter" title="Miter join"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter"><path d="M5 20V6h13"/></svg></button>
        <button data-join="round" title="Round join"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20v-6a8 8 0 0 1 8-8h5"/></svg></button>
        <button data-join="bevel" title="Bevel join"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M5 20v-9l5-5h8"/></svg></button>
      </div>
      <div class="seclabel">Cap</div>
      <div class="seg" id="capSeg">
        <button data-cap="butt" title="Butt cap"><svg width="34" height="20" viewBox="0 0 34 20"><line x1="4" y1="10" x2="20" y2="10" stroke="currentColor" stroke-width="7" stroke-linecap="butt"/><line x1="20" y1="3" x2="20" y2="17" stroke="#3a3d42" stroke-width="1.5"/></svg></button>
        <button data-cap="round" title="Round cap"><svg width="34" height="20" viewBox="0 0 34 20"><line x1="4" y1="10" x2="20" y2="10" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><line x1="20" y1="3" x2="20" y2="17" stroke="#3a3d42" stroke-width="1.5"/></svg></button>
        <button data-cap="square" title="Square cap"><svg width="34" height="20" viewBox="0 0 34 20"><line x1="4" y1="10" x2="20" y2="10" stroke="currentColor" stroke-width="7" stroke-linecap="square"/><line x1="20" y1="3" x2="20" y2="17" stroke="#3a3d42" stroke-width="1.5"/></svg></button>
      </div>
      <div class="seclabel">Dashes</div>
      <div class="dashes" id="dashSeg">
        <button data-dash="solid"><svg width="100%" height="6" viewBox="0 0 240 6" preserveAspectRatio="none"><line x1="2" y1="3" x2="238" y2="3" stroke="#C9CDD3" stroke-width="3"/></svg></button>
        <button data-dash="dashed"><svg width="100%" height="6" viewBox="0 0 240 6" preserveAspectRatio="none"><line x1="2" y1="3" x2="238" y2="3" stroke="#C9CDD3" stroke-width="3" stroke-dasharray="14 9"/></svg></button>
        <button data-dash="dotted"><svg width="100%" height="6" viewBox="0 0 240 6" preserveAspectRatio="none"><line x1="2" y1="3" x2="238" y2="3" stroke="#C9CDD3" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 10"/></svg></button>
        <button data-dash="dashdot"><svg width="100%" height="6" viewBox="0 0 240 6" preserveAspectRatio="none"><line x1="2" y1="3" x2="238" y2="3" stroke="#C9CDD3" stroke-width="3" stroke-linecap="round" stroke-dasharray="16 8 0.1 8"/></svg></button>
      </div>
      ${transformAndOpacityHTML(sel)}`;
    wireStrokeStyle(sel);
    wireTransformOpacity(sel);
    return;
  }

  // Fill / Stroke paint tabs: paint-type row + HSV picker + hex/opacity + swatches.
  const checker = "background-color:#33363b;background-image:linear-gradient(45deg,#C9CDD3 25%,transparent 25%),linear-gradient(-45deg,#C9CDD3 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#C9CDD3 75%),linear-gradient(-45deg,transparent 75%,#C9CDD3 75%);background-size:8px 8px;background-position:0 0,0 4px,4px -4px,-4px 0";
  const gradDisabled = strokeTab ? "disabled" : "";   // gradients/patterns: fill only
  body.innerHTML = `
    <div class="painttypes" id="paintTypes">
      <button class="pt" data-pt="none" title="No paint"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9BA0A6" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="3" stroke="#3a3d42"/><path d="M6 6l12 12"/></svg></button>
      <button class="pt active" data-pt="flat" title="Flat colour"><span class="chip" style="background:#C9CDD3"></span></button>
      <button class="pt" data-pt="linear" title="Linear gradient" ${gradDisabled}><span class="chip" style="background:linear-gradient(90deg,#C9CDD3,#33363b)"></span></button>
      <button class="pt" data-pt="radial" title="Radial gradient" ${gradDisabled}><span class="chip" style="background:radial-gradient(circle at 35% 35%,#C9CDD3,#33363b)"></span></button>
      <button class="pt" data-pt="pattern" title="Pattern (not yet)" disabled><span class="chip" style="${checker}"></span></button>
    </div>
    <div class="sv" id="sv"><div class="wlayer"></div><div class="blayer"></div><div class="knob" id="svDot"></div></div>
    <div class="hue" id="hue"><div class="barknob" id="hueDot"></div></div>
    <div class="alpha" id="alpha"><div class="fill" id="alphaFill"></div><div class="barknob" id="alphaDot"></div></div>
    <div class="hexrow">
      <div class="hexbox"><span class="h">#</span><input id="hexField" maxlength="6" spellcheck="false" /></div>
      <div class="opbox"><input id="opField" /><span class="pc">%</span></div>
    </div>
    <div class="swatches" id="swatches">${SWATCHES.map((c) => `<button data-c="${c}" style="background:${c}"></button>`).join("")}</div>
    ${isText ? fontHTML() : ""}
    ${transformAndOpacityHTML(sel)}`;

  // Initialise the active paint from the selection's computed colour.
  if (sel) {
    const prop = strokeTab ? "stroke" : "fill";
    call0("computedStyle", { node: sel.id, property: prop }).then((v) => {
      const m = (v || "").match(/^#?[0-9a-fA-F]{6}$|^#?[0-9a-fA-F]{3}$/);
      if (m) { paint[activeKey()] = { ...paint[activeKey()], ...hex2hsv(v) }; syncPicker(); }
    }).catch(() => {});
    call0("computedStyle", { node: sel.id, property: strokeTab ? "stroke-opacity" : "fill-opacity" }).then((v) => {
      const f = parseFloat(v); if (!Number.isNaN(f)) { paint[activeKey()].a = Math.round(f * 100); syncPicker(); }
    }).catch(() => {});
  }
  wirePicker();
  if (isText) wireFont(sel);
  wireTransformOpacity(sel);
  syncPicker();
}

// Transform grid (editable X/Y/W/H/∠, populated from selection-bounds) + opacity.
function transformAndOpacityHTML(sel) {
  const dis = sel ? "" : "disabled";
  const cell = (k, id) => `<div class="cell"><span class="k">${k}</span><input class="v" id="${id}" inputmode="decimal" ${dis} placeholder="—"></div>`;
  const rotIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6B7077" stroke-width="1.9" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`;
  const cornIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6B7077" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h6v10H4zM14 9h6v6h-6z"/></svg>`;
  return `
    <div class="hr"></div>
    <div class="tgrid">
      ${cell("X", "tX")}
      ${cell("Y", "tY")}
      ${cell("W", "tW")}
      ${cell("H", "tH")}
      ${cell(rotIcon, "tR")}
      <div class="cell"><span class="k">${cornIcon}</span><span class="v" id="tC">—</span></div>
    </div>
    <button class="lockaspect" id="aspectLock" ${dis} title="Lock width/height aspect ratio">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
      <span>Lock W:H</span>
    </button>
    <div class="seclabel">Opacity</div>
    <div class="oprow"><div class="slider" id="opSlider"><div class="fill" id="opFill"></div><div class="knob" id="opKnob"></div></div><span class="val" id="opVal">${sel ? "" : "—"}</span></div>`;
}

function fontHTML() {
  const opts = FONTS.map((f) => `<option value="${f.family}">${f.label}</option>`).join("");
  return `
    <div class="hr"></div>
    <div class="seclabel">Font</div>
    <select id="fontfam" class="optgrid" style="width:100%;background:var(--input);border:1px solid var(--line);border-radius:8px;color:var(--text);font-size:12.5px;padding:8px 10px;margin-bottom:12px;outline:none">${opts}</select>
    <div class="seclabel">Font size</div>
    <div class="wfield" style="margin-bottom:4px"><input id="fontsize" value="24" /><span class="u">px</span></div>`;
}

// Generic horizontal slider drag helper (returns 0..1 fraction).
function dragFrac(el, onFrac) {
  const upd = (e) => {
    const r = el.getBoundingClientRect();
    onFrac(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), e);
  };
  let active = false;
  el.addEventListener("pointerdown", (e) => { active = true; try { el.setPointerCapture(e.pointerId); } catch (_) {} upd(e); });
  el.addEventListener("pointermove", (e) => { if (active) upd(e); });
  el.addEventListener("pointerup", () => { active = false; });
  el.addEventListener("pointercancel", () => { active = false; });
}

function wirePicker() {
  // paint types
  $("paintTypes").querySelectorAll(".pt").forEach((b) => {
    if (b.disabled) return;
    b.addEventListener("click", () => {
      $("paintTypes").querySelectorAll(".pt").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const pt = b.dataset.pt;
      if (pt === "none") { (activeKey() === "fill" ? call0("setFill", { color: "none" }) : call0("setStroke", { color: "none" })).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail); }
      else if (pt === "flat") pushColor();
      else if (pt === "linear" || pt === "radial") call0("setFillGradient", { kind: pt }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); refreshPanels(); }).catch(fail);
    });
  });
  // SV square — two-axis drag
  const sv = $("sv");
  const svUpd = (e) => {
    const r = sv.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    activePaint().s = Math.round(fx * 100); activePaint().v = Math.round((1 - fy) * 100);
    syncPicker(); pushColor();
  };
  let svActive = false;
  sv.addEventListener("pointerdown", (e) => { svActive = true; try { sv.setPointerCapture(e.pointerId); } catch (_) {} svUpd(e); });
  sv.addEventListener("pointermove", (e) => { if (svActive) svUpd(e); });
  sv.addEventListener("pointerup", () => { svActive = false; });
  sv.addEventListener("pointercancel", () => { svActive = false; });
  dragFrac($("hue"), (f) => { activePaint().h = Math.round(f * 360); syncPicker(); pushColor(); });
  dragFrac($("alpha"), (f) => { activePaint().a = Math.round(f * 100); syncPicker(); pushAlpha(); });
  const hexF = $("hexField"), opF = $("opField");
  hexF.addEventListener("input", () => { const v = hexF.value.replace(/[^0-9a-fA-F]/g, ""); if (v.length === 6 || v.length === 3) { paint[activeKey()] = { ...paint[activeKey()], ...hex2hsv(v) }; syncPicker(); pushColor(); } });
  opF.addEventListener("change", () => { const n = parseInt(opF.value, 10); if (!Number.isNaN(n)) { activePaint().a = Math.max(0, Math.min(100, n)); syncPicker(); pushAlpha(); } });
  $("swatches").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => applyActivePaint(b.dataset.c)));
}

function wireFont(sel) {
  const fam = $("fontfam"), size = $("fontsize");
  const generic = { "sans-serif": "DejaVu Sans", "serif": "DejaVu Serif", "monospace": "DejaVu Sans Mono" };
  call0("computedStyle", { node: sel.id, property: "font-family" }).then((v) => {
    const first = (v || "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
    fam.value = generic[first.toLowerCase()] || (FONTS.find((f) => f.family === first)?.family) || FONTS[0].family;
  }).catch(() => {});
  call0("computedStyle", { node: sel.id, property: "font-size" }).then((v) => { const px = parseFloat(v); if (!isNaN(px)) size.value = Math.round(px); }).catch(() => {});
  const apply = (property, value) => call0("setStyleProperty", { property, value }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail);
  fam.addEventListener("change", () => apply("font-family", fam.value));
  size.addEventListener("change", () => apply("font-size", Math.max(1, parseFloat(size.value) || 24) + "px"));
}

function wireStrokeStyle(sel) {
  const SW_MAX = 20;
  let w = 2;
  const wInput = $("wInput"), wFill = $("wFill"), wKnob = $("wKnob");
  const showW = () => { wInput.value = String(w); const pc = Math.min(100, w / SW_MAX * 100) + "%"; wFill.style.width = pc; wKnob.style.left = pc; };
  const setW = (nw, push = true) => { w = Math.max(0, Math.round(nw * 10) / 10); showW(); if (push) call0("setStrokeWidth", { width: w }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail); };
  if (sel) call0("computedStyle", { node: sel.id, property: "stroke-width" }).then((v) => { const f = parseFloat(v); if (!Number.isNaN(f)) setW(f, false); }).catch(() => {});
  showW();
  $("wDec").addEventListener("click", () => setW(w - 1));
  $("wInc").addEventListener("click", () => setW(w + 1));
  wInput.addEventListener("change", () => { const f = parseFloat(wInput.value); if (!Number.isNaN(f)) setW(f); });
  dragFrac($("wSlider"), (f) => setW(f * SW_MAX));

  const seg = (id, prop, attr) => {
    const host = $(id);
    const sync = (val) => host.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset[attr] === val));
    if (sel) call0("computedStyle", { node: sel.id, property: prop }).then((v) => sync((v || "").trim())).catch(() => {});
    host.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      sync(b.dataset[attr]);
      const value = prop === "stroke-dasharray" ? DASH[b.dataset[attr]] : b.dataset[attr];
      call0("setStyleProperty", { property: prop, value }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail);
    }));
  };
  seg("joinSeg", "stroke-linejoin", "join");
  seg("capSeg", "stroke-linecap", "cap");
  // dashes match on the resolved dasharray value
  const dashHost = $("dashSeg");
  if (sel) call0("computedStyle", { node: sel.id, property: "stroke-dasharray" }).then((v) => {
    const cur = (v || "none").replace(/\s+/g, "");
    const key = Object.keys(DASH).find((k) => DASH[k].replace(/\s+/g, "") === cur) || "solid";
    dashHost.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.dash === key));
  }).catch(() => {});
  dashHost.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    dashHost.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    call0("setStyleProperty", { property: "stroke-dasharray", value: DASH[b.dataset.dash] }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail);
  }));
}

function wireTransformOpacity(sel) {
  const slider = $("opSlider"); if (!slider) return;
  const fillEl = $("opFill"), knob = $("opKnob"), valEl = $("opVal");
  let op = 1;
  const show = () => { const pc = Math.round(op * 100); fillEl.style.width = pc + "%"; knob.style.left = pc + "%"; valEl.textContent = pc + "%"; };
  if (sel) {
    call0("computedStyle", { node: sel.id, property: "opacity" }).then((v) => { const f = parseFloat(v); op = Number.isNaN(f) ? 1 : f; show(); }).catch(() => { show(); });
    dragFrac(slider, (f) => { op = f; show(); call0("setStyleProperty", { property: "opacity", value: String(Math.round(f * 100) / 100) }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); }).catch(fail); });
  } else { valEl.textContent = "—"; }
  populateTransform();
  wireTransform();
}

// Fill the transform grid (X/Y/W/H/∠) inputs from the engine's selection bounds
// (document px). Empty when nothing is selected.
const TFIELDS = ["tX", "tY", "tW", "tH", "tR"];
let aspectLocked = localStorage.getItem("penna.aspectLock") === "1";
let tAspect = 1; // W:H ratio of the current selection (for the lock)
function populateTransform() {
  const set = (id, v) => { const el = $(id); if (el && el.tagName === "INPUT") el.value = v; };
  call0("selectionBounds").then((b) => {
    if (!b) { for (const id of TFIELDS) set(id, ""); return; }
    const r = (n) => (Math.round(n * 10) / 10).toString();
    set("tX", r(b.x)); set("tY", r(b.y)); set("tW", r(b.width)); set("tH", r(b.height));
    set("tR", r(b.rotation));
    if (b.height > 0) tAspect = b.width / b.height;
  }).catch(() => {});
}

// Editing any X/Y/W/H/∠ field transforms the selection to those bounds (move /
// resize / rotate). Commit on Enter or blur; Escape (or a bad value) restores.
// With the aspect lock on, editing W adjusts H to keep the W:H ratio (and vice versa).
function wireTransform() {
  const v = (id) => parseFloat($(id).value);
  const r1 = (n) => (Math.round(n * 10) / 10).toString();
  const send = () => {
    const b = { x: v("tX"), y: v("tY"), width: v("tW"), height: v("tH"), rotation: v("tR") };
    if (Object.values(b).some((n) => Number.isNaN(n)) || b.width <= 0 || b.height <= 0) { populateTransform(); return; }
    call0("setSelectionBounds", { b }).then((d) => { markDocDirty(); if (d && d.full) requestRender(); refreshPanels(); }).catch(fail);
  };
  const commit = (id) => {
    if (aspectLocked && tAspect > 0) {
      if (id === "tW") { const w = v("tW"); if (w > 0) $("tH").value = r1(w / tAspect); }
      else if (id === "tH") { const h = v("tH"); if (h > 0) $("tW").value = r1(h * tAspect); }
    }
    send();
  };
  for (const id of TFIELDS) {
    const el = $(id); if (!el) continue;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); populateTransform(); el.blur(); }
    });
    el.addEventListener("change", () => commit(id));
  }
  const lk = $("aspectLock");
  if (lk) {
    lk.classList.toggle("on", aspectLocked);
    lk.addEventListener("click", () => {
      aspectLocked = !aspectLocked;
      localStorage.setItem("penna.aspectLock", aspectLocked ? "1" : "0");
      lk.classList.toggle("on", aspectLocked);
    });
  }
}

// ---- contextual toolbar (bottom-center) ------------------------------------
function updateCtxBar(sel, selCount) {
  const has = !!sel, multi = selCount >= 2;
  document.querySelectorAll(".ctxbar [data-bool]").forEach((b) => (b.disabled = !multi));
  $("ctxGroup").disabled = !has;
  $("ctxUngroup").disabled = !has;
  // Flatten (object→path): only for basic shapes or a multi-selection — a plain
  // <path> needs no conversion (mirrors Inkscape's "Object to Path").
  const SHAPE_TAGS = ["rect", "circle", "ellipse", "line", "polygon", "polyline"];
  $("ctxFlatten").disabled = !(multi || (has && SHAPE_TAGS.includes(sel.tag)));
  $("ctxDelete").disabled = !has;
  // Align/distribute live in the right-panel Align tab now (Inkscape-style).
  // Page-relative align works on a single object; selection-relative needs 2+.
  const alignMin = alignRef === "page" ? 1 : 2;
  document.querySelectorAll("#paneAlign [data-align]").forEach((b) => (b.disabled = selCount < alignMin));
  document.querySelectorAll("#paneAlign [data-dist]").forEach((b) => (b.disabled = selCount < 3));
  const tip = $("alignTip");
  if (tip) {
    tip.textContent = alignRef === "page"
      ? "Select an object to align it to the page (3+ to distribute)."
      : "Select 2+ objects to align (3+ to distribute).";
    tip.style.display = selCount >= alignMin ? "none" : "block";
  }
}

function wireCtxBar() {
  const run = (p) => p.then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail);
  document.querySelectorAll(".ctxbar [data-bool]").forEach((b) => b.addEventListener("click", () => run(call0("pathBoolean", { op: b.dataset.bool }))));
  $("ctxGroup").addEventListener("click", () => run(call0("group")));
  $("ctxUngroup").addEventListener("click", () => run(call0("ungroup")));
  $("ctxFlatten").addEventListener("click", () => run(call0("toPath")));
  $("ctxDelete").addEventListener("click", () => run(call0("deleteSelection")));
  // Align tab (right panel): align the selection to the page or its own bbox.
  document.querySelectorAll("#paneAlign [data-align]").forEach((b) => b.addEventListener("click", () => run(call0("align", { mode: b.dataset.align, relativeTo: alignRef }))));
  document.querySelectorAll("#paneAlign [data-dist]").forEach((b) => b.addEventListener("click", () => run(call0("distribute", { mode: b.dataset.dist }))));
  // "Relative to" toggle (Page / Selection) — re-evaluates which buttons enable.
  document.querySelectorAll("#alignRef button").forEach((b) => b.addEventListener("click", () => {
    alignRef = b.dataset.ref;
    document.querySelectorAll("#alignRef button").forEach((x) => x.classList.toggle("active", x === b));
    refreshPanels();
  }));
  updateCtxGroups();
}

function wirePanels() {
  document.querySelectorAll("#propTabs button").forEach((b) =>
    b.addEventListener("click", () => {
      propTab = b.dataset.ptab;
      document.querySelectorAll("#propTabs button").forEach((x) => x.classList.toggle("active", x === b));
      refreshPanels();
    }));
  // Top-level Properties / Layers tabs — switch which pane fills the panel.
  document.querySelectorAll("#paneltabs button").forEach((b) =>
    b.addEventListener("click", () => {
      const pane = b.dataset.pane;
      document.querySelectorAll("#paneltabs button").forEach((x) => x.classList.toggle("active", x === b));
      $("paneProps").hidden = pane !== "props";
      $("paneAlign").hidden = pane !== "align";
      $("paneLayers").hidden = pane !== "layers";
    }));
  $("addLayer").addEventListener("click", () =>
    call0("createLayer", { label: "Layer" }).then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  wirePanelResize();
  wireCtxBar();
}

// Drag the panel's left-edge handle to resize its width (clamped + persisted).
function wirePanelResize() {
  const panel = $("panel"), rez = $("panelResizer");
  const MIN = 240, MAX = 620;
  const saved = parseInt(localStorage.getItem("penna.panelW") || "", 10);
  if (saved >= MIN && saved <= MAX) { panel.style.flexBasis = saved + "px"; panel.style.width = saved + "px"; }
  let startX = 0, startW = 0, active = false;
  rez.addEventListener("pointerdown", (e) => {
    active = true; startX = e.clientX; startW = panel.getBoundingClientRect().width;
    rez.classList.add("drag");
    try { rez.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  rez.addEventListener("pointermove", (e) => {
    if (!active) return;
    const w = Math.max(MIN, Math.min(MAX, startW + (startX - e.clientX)));   // drag left = wider
    panel.style.flexBasis = w + "px"; panel.style.width = w + "px";
    requestRender();                                                          // canvas width changed
  });
  const end = () => {
    if (!active) return;
    active = false; rez.classList.remove("drag");
    try { localStorage.setItem("penna.panelW", String(Math.round(panel.getBoundingClientRect().width))); } catch (_) {}
  };
  rez.addEventListener("pointerup", end);
  rez.addEventListener("pointercancel", end);
}

// ---- top bar ---------------------------------------------------------------
function wireTopbar() {
  $("undo").addEventListener("click", () => call0("undo").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  $("redo").addEventListener("click", () => call0("redo").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  // Zoom about the viewport centre (top-bar group); Fit lives on the zoom pill.
  $("zoomIn").addEventListener("click", () => { zoomAt(cssW() / 2, cssH() / 2, BTN_ZOOM); requestRenderCam(); });
  $("zoomOut").addEventListener("click", () => { zoomAt(cssW() / 2, cssH() / 2, 1 / BTN_ZOOM); requestRenderCam(); });
  $("fit").addEventListener("click", () => { fit(); requestRenderCam(); });

  // The doc pill opens a dropdown menu (Open / Save / Save as…). Open uses the
  // hidden <input>; the home screen offers open + new too.
  const file = $("file");
  file.addEventListener("change", async () => {
    if (file.files[0]) {
      const name = file.files[0].name;
      const bytes = new Uint8Array(await file.files[0].arrayBuffer());
      $("docname").textContent = name;
      await rememberDoc({ name, bytes });    // copies bytes before openSvg transfers
      await openSvg(bytes);
    }
  });
  wireDocMenu(() => leaveGuard(() => file.click()));   // Open replaces the doc → guard unsaved edits

  // Inserting an image adds to the current doc (no replace → no leave-guard).
  const imageFile = $("imageFile");
  imageFile.addEventListener("change", async () => {
    const f = imageFile.files[0];
    imageFile.value = "";
    if (f) { try { await embedImageFile(f); } catch (e) { fail(e); } }
  });

  $("exportBtn").addEventListener("click", openExportModal);
  wireExportModal();
  wireConfirm();
  wireDocProps();
}

// ---- save + the document menu ----------------------------------------------
// Save the current document. On the web this downloads an SVG (the browser's own
// save dialog picks the location). Returns true on success / false if nothing is
// loaded or it was cancelled.
async function saveDocument() {
  if (!loaded) return false;
  try {
    const name = ($("docname").textContent || "document.svg").replace(/\.svg$/i, "") + ".svg";
    const bytes = await call0("save");
    if (!bytes || bytes.length === 0) { fail(new Error("Save aborted: the document serialized to 0 bytes.")); return false; }
    await rememberDoc({ name, bytes });
    downloadBlob(new Blob([bytes], { type: "image/svg+xml" }), name);
    setUnsaved(false);
    await clearDraft();                                // persisted → drop the recovery draft
    return true;
  } catch (e) { fail(e); return false; }
}
// Save under a new name ("Save as…"): prompt for the file name, then download.
async function saveDocumentAs() {
  if (!loaded) return false;
  const cur = ($("docname").textContent || "document.svg").replace(/\.svg$/i, "");
  const input = window.prompt("Save as — file name:", cur);
  if (input === null) return false;                  // cancelled
  const name = (input.trim() || cur).replace(/\.svg$/i, "") + ".svg";
  try {
    const bytes = await call0("save");
    if (!bytes || bytes.length === 0) { fail(new Error("Save aborted: the document serialized to 0 bytes.")); return false; }
    $("docname").textContent = name;
    await rememberDoc({ name, bytes });
    downloadBlob(new Blob([bytes], { type: "image/svg+xml" }), name);
    setUnsaved(false);
    await clearDraft();                                // persisted → drop the recovery draft
    return true;
  } catch (e) { fail(e); return false; }
}

// ---- insert image ----------------------------------------------------------
// Embed a raster image (PNG/JPEG/GIF) as a self-contained `<image>` element. We
// read it as a base64 `data:` URI (so the SVG stays portable) and measure its
// intrinsic size via the Image API, then hand both to the engine, which inserts
// the `<image>` into the current layer as one undoable edit and selects it.
async function embedImageFile(f) {
  const href = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("could not read image"));
    r.readAsDataURL(f);                              // -> "data:<mime>;base64,…"
  });
  const dim = await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => rej(new Error("could not decode image"));
    img.src = href;
  });
  if (!dim.width || !dim.height) throw new Error("image has no intrinsic size");
  await call0("embedImage", { href, width: dim.width, height: dim.height });
  markDocDirty();
  await refreshPanels();
  requestRender();
}
// Open the image picker (only when a document is loaded — we need a layer to
// insert into). Reset .value so re-picking the same file still fires `change`.
function pickImage() {
  if (!loaded) return;
  const inp = $("imageFile");
  inp.value = "";
  inp.click();
}

function wireDocMenu(openFn) {
  const pill = $("docPill"), menu = $("docMenu");
  const close = () => { menu.hidden = true; };
  pill.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  menu.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    close();
    const act = b.dataset.act;
    if (act === "open") openFn();
    else if (act === "insert-image") pickImage();
    else if (act === "save") saveDocument();
    else if (act === "saveas") saveDocumentAs();
    else if (act === "props") openDocProps();
  }));
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !$("docMenu").contains(e.target) && !pill.contains(e.target)) close(); });
}

// ---- unsaved-changes guard --------------------------------------------------
// Run `action` only once it's safe to discard the current document: if there are
// unsaved edits, show a Save / Discard / Cancel dialog first.
let pendingLeave = null;
function leaveGuard(action) {
  if (loaded && unsaved) { pendingLeave = action; showConfirm(); }
  else action();
}
function showConfirm() {
  $("confirmName").textContent = $("docname").textContent || "document.svg";
  $("confirmModal").hidden = false;
}
function hideConfirm() { $("confirmModal").hidden = true; }
function wireConfirm() {
  const run = () => { const a = pendingLeave; pendingLeave = null; hideConfirm(); if (a) a(); };
  $("confirmDiscard").addEventListener("click", run);
  $("confirmSave").addEventListener("click", async () => { if (await saveDocument()) run(); });
  $("confirmCancel").addEventListener("click", () => { pendingLeave = null; hideConfirm(); });
  $("confirmClose").addEventListener("click", () => { pendingLeave = null; hideConfirm(); });
  $("confirmModal").addEventListener("click", (e) => { if (e.target === $("confirmModal")) { pendingLeave = null; hideConfirm(); } });
}

// ---- document properties (page size / units / orientation) -----------------
const UNIT_PX = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72 };  // CSS px per unit (96 dpi)
const DP_UNITS = ["px", "mm", "cm", "in", "pt"];
const DP_PRESETS = [
  { name: "Custom" },
  { name: "A4 — 210 × 297 mm", w: 210, h: 297, unit: "mm" },
  { name: "A3 — 297 × 420 mm", w: 297, h: 420, unit: "mm" },
  { name: "A5 — 148 × 210 mm", w: 148, h: 210, unit: "mm" },
  { name: "US Letter — 8.5 × 11 in", w: 8.5, h: 11, unit: "in" },
  { name: "US Legal — 8.5 × 14 in", w: 8.5, h: 14, unit: "in" },
  { name: "Square — 1080 × 1080 px", w: 1080, h: 1080, unit: "px" },
  { name: "HD — 1920 × 1080 px", w: 1920, h: 1080, unit: "px" },
  { name: "Screen — 800 × 600 px", w: 800, h: 600, unit: "px" },
];
let dpUnit = "px";                 // the unit the W/H fields are currently in
const dpRound = (n) => Math.round(n * 100) / 100;   // 2 dp, trimmed by Number()

function syncDpPreset() {
  const w = parseFloat($("dpW").value), h = parseFloat($("dpH").value), u = $("dpUnit").value;
  const i = DP_PRESETS.findIndex((p) => p.unit === u && p.w === w && p.h === h);
  $("dpPreset").value = String(i >= 0 ? i : 0);
}

async function openDocProps() {
  if (!loaded) return;
  try {
    docInfo = await call0("documentInfo");
    const u = DP_UNITS.includes(docInfo.displayUnit) ? docInfo.displayUnit : "px";
    dpUnit = u;
    $("dpUnit").value = u;
    $("dpW").value = String(Number(dpRound(docInfo.widthPx / UNIT_PX[u])));
    $("dpH").value = String(Number(dpRound(docInfo.heightPx / UNIT_PX[u])));
    const pc = docInfo.pageColor || "#ffffff";
    $("dpBg").value = /^#[0-9a-fA-F]{6}$/.test(pc) ? pc.toLowerCase() : "#ffffff";
    $("dpBgHex").value = $("dpBg").value.slice(1);
    syncDpPreset();
    $("docPropsModal").hidden = false;
  } catch (e) { fail(e); }
}
const closeDocProps = () => { $("docPropsModal").hidden = true; };

async function applyDocProps() {
  const unit = $("dpUnit").value;
  const w = parseFloat($("dpW").value), h = parseFloat($("dpH").value);
  if (!(w > 0) || !(h > 0)) { fail(new Error("Enter a positive width and height.")); return; }
  const color = $("dpBg").value;
  try {
    // Only apply what actually changed, so the undo history stays clean.
    const sizeChanged = !docInfo || unit !== docInfo.displayUnit
      || Math.abs(w * UNIT_PX[unit] - docInfo.widthPx) > 0.5
      || Math.abs(h * UNIT_PX[unit] - docInfo.heightPx) > 0.5;
    const colorChanged = color.toLowerCase() !== ((docInfo && docInfo.pageColor) || "#ffffff").toLowerCase();
    if (sizeChanged) await call0("setDocumentSize", { width: w, height: h, unit });
    if (colorChanged) await call0("setPageColor", { color });
    if (sizeChanged || colorChanged) {
      markDocDirty();
      bounds = await call0("documentBounds");
      docInfo = await call0("documentInfo");
      requestRender();
      updatePage();        // reflect the new page size / colour on the backdrop
      updateArtboard();
      refreshPanels();
    }
    closeDocProps();
  } catch (e) { fail(e); }
}

function wireDocProps() {
  // populate the unit + preset dropdowns once
  $("dpUnit").innerHTML = DP_UNITS.map((u) => `<option value="${u}">${u}</option>`).join("");
  $("dpPreset").innerHTML = DP_PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join("");

  $("dpPreset").addEventListener("change", () => {
    const p = DP_PRESETS[parseInt($("dpPreset").value, 10)];
    if (!p || !p.unit) return;                       // "Custom"
    dpUnit = p.unit; $("dpUnit").value = p.unit;
    $("dpW").value = String(p.w); $("dpH").value = String(p.h);
  });
  // changing the unit converts the W/H values to keep the physical size
  $("dpUnit").addEventListener("change", () => {
    const to = $("dpUnit").value, w = parseFloat($("dpW").value), h = parseFloat($("dpH").value);
    if (w > 0) $("dpW").value = String(Number(dpRound(w * UNIT_PX[dpUnit] / UNIT_PX[to])));
    if (h > 0) $("dpH").value = String(Number(dpRound(h * UNIT_PX[dpUnit] / UNIT_PX[to])));
    dpUnit = to; syncDpPreset();
  });
  for (const el of [$("dpW"), $("dpH")]) el.addEventListener("input", syncDpPreset);
  // page-background colour: keep the swatch and the hex field in sync
  $("dpBg").addEventListener("input", () => { $("dpBgHex").value = $("dpBg").value.slice(1); });
  $("dpBgHex").addEventListener("input", () => { const v = $("dpBgHex").value.replace(/[^0-9a-fA-F]/g, ""); if (v.length === 6) $("dpBg").value = "#" + v; });
  // orientation: swap W/H so the long side matches
  $("dpOrient").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const w = parseFloat($("dpW").value), h = parseFloat($("dpH").value);
    if (!(w > 0) || !(h > 0)) return;
    const land = b.dataset.o === "landscape";
    const [nw, nh] = land ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
    $("dpW").value = String(nw); $("dpH").value = String(nh);
    syncDpPreset();
  }));

  $("dpApply").addEventListener("click", applyDocProps);
  $("dpCancel").addEventListener("click", closeDocProps);
  $("dpClose").addEventListener("click", closeDocProps);
  $("docPropsModal").addEventListener("click", (e) => { if (e.target === $("docPropsModal")) closeDocProps(); });
}

// ---- export modal ----------------------------------------------------------
let expFmt = "png", expTransparent = true, expInfo = null;

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function updateExpSize() {
  const s = parseInt($("expScale").value, 10) || 1;
  const w = Math.max(1, Math.round((expInfo ? expInfo.widthPx : bounds.width) * s));
  const h = Math.max(1, Math.round((expInfo ? expInfo.heightPx : bounds.height) * s));
  $("expSize").textContent = `${w} × ${h}`;
  return { w, h };
}

// Rasterize the whole page at w×h via the worker tile renderer, composited over
// white when the "transparent" toggle is off. Returns a <canvas>.
async function renderExpDoc(w, h) {
  const vp = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const f = await call0("renderTile", { viewport: vp, size: { width: w, height: h } });
  const tmp = document.createElement("canvas"); tmp.width = f.width; tmp.height = f.height;
  tmp.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, f.data.byteLength), f.width, f.height), 0, 0);
  const c = document.createElement("canvas"); c.width = f.width; c.height = f.height;
  const cx = c.getContext("2d");
  if (!expTransparent) { cx.fillStyle = (docInfo && docInfo.pageColor) || "#fff"; cx.fillRect(0, 0, c.width, c.height); }
  cx.drawImage(tmp, 0, 0);
  return c;
}

async function renderExpPreview() {
  const aw = expInfo ? expInfo.widthPx : bounds.width, ah = expInfo ? expInfo.heightPx : bounds.height;
  const aspect = (aw || 1) / (ah || 1);
  let pw = 300, ph = Math.round(pw / aspect);
  if (ph > 150) { ph = 150; pw = Math.round(ph * aspect); }
  const c = await renderExpDoc(Math.max(1, pw), Math.max(1, ph));
  $("expPreview").src = c.toDataURL("image/png");
  $("expPreview").parentElement.style.background = expTransparent ? "transparent" : "#fff";
}

async function openExportModal() {
  if (!loaded) return;
  try {
    expInfo = await call0("documentInfo");
    updateExpSize();
    await renderExpPreview();
    $("exportModal").hidden = false;
  } catch (e) { fail(e); }
}
const closeExportModal = () => { $("exportModal").hidden = true; };

async function doExport() {
  try {
    const base = ($("docname").textContent || "document").replace(/\.svg$/i, "");
    if (expFmt === "svg") {
      const bytes = await call0("save");
      await rememberDoc({ name: base + ".svg", bytes });
      downloadBlob(new Blob([bytes], { type: "image/svg+xml" }), base + ".svg");
      setUnsaved(false);
      closeExportModal();
      return;
    }
    const { w, h } = updateExpSize();
    const c = await renderExpDoc(w, h);
    const mime = expFmt === "webp" ? "image/webp" : "image/png";
    const ext = expFmt === "webp" ? "webp" : "png";
    c.toBlob((blob) => { if (blob) downloadBlob(blob, `${base}.${ext}`); }, mime);
    closeExportModal();
  } catch (e) { fail(e); }
}

function wireExportModal() {
  $("expClose").addEventListener("click", closeExportModal);
  $("expCancel").addEventListener("click", closeExportModal);
  $("exportModal").addEventListener("click", (e) => { if (e.target === $("exportModal")) closeExportModal(); });
  $("expFormats").querySelectorAll("button").forEach((b) => {
    if (b.disabled) return;
    b.addEventListener("click", () => {
      expFmt = b.dataset.fmt;
      $("expFormats").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      $("expGoLabel").textContent = expFmt === "svg" ? "Save SVG" : "Export " + expFmt.toUpperCase();
    });
  });
  $("expScale").addEventListener("change", updateExpSize);
  $("expTransparent").addEventListener("click", () => {
    expTransparent = !expTransparent;
    $("expTransparent").classList.toggle("on", expTransparent);
    $("expTransparent").setAttribute("aria-pressed", String(expTransparent));
    renderExpPreview().catch(fail);
  });
  $("expGo").addEventListener("click", doExport);
}

// ---- load a document -------------------------------------------------------
// Shared tail: after worker 0 holds a new/loaded document, fit + paint + reveal
// the editor (hiding the home screen). markDocDirty makes the pool re-sync.
async function enterEditor() {
  markDocDirty();                    // pool instances need the new doc
  bounds = await call0("documentBounds");
  try { docInfo = await call0("documentInfo"); } catch { docInfo = null; }
  fit();
  loaded = true;
  const painted = new Promise((r) => { firstPaint = r; });
  requestRender();
  await painted;
  refreshPanels();
  setUnsaved(false);                 // a freshly opened/new document has no edits
  updateArtboard();
  hideHome();
}

async function openSvg(bytes) {
  try {
    await ready;                     // a home action may fire before the pool is up
    await call0("load", { bytes }, [bytes.buffer]);
    await enterEditor();
  } catch (err) { fail(err); }
}

// On boot, if a recovery draft exists (unsaved work from a previous session that
// crashed or was reloaded), offer to restore it. Declining discards it.
async function maybeOfferRestore() {
  let draft = null;
  try { draft = await loadDraft(); } catch { draft = null; }
  if (!draft) return false;
  const ok = window.confirm(`Restore unsaved changes to “${draft.name || "document.svg"}” from ${relTime(draft.ts)}?`);
  if (!ok) { await clearDraft(); return false; }
  $("docname").textContent = draft.name || "document.svg";
  await openSvg(draft.bytes);
  setUnsaved(true);                  // restored work is not yet saved to a file
  return true;
}

// Create a blank document from a named template (blank-px/blank-mm/a4-*).
async function newDoc(template) {
  try {
    await ready;
    await call0("newDocument", { template });
    $("docname").textContent = "untitled.svg";
    await enterEditor();
  } catch (err) { fail(err); }
}

// Create a blank document of an arbitrary size (custom-size card).
async function newDocSized(width, height, unit) {
  try {
    await ready;
    await call0("newDocumentSized", { width, height, unit });
    $("docname").textContent = "untitled.svg";
    await enterEditor();
  } catch (err) { fail(err); }
}

// ---- home screen -----------------------------------------------------------
const homeEl = $("home");
function hideHome() { homeEl.hidden = true; }
function showHome() { renderRecents(); homeEl.hidden = false; }
function homeTab(tab) {
  document.querySelectorAll("#homeTabs button").forEach((b) => b.classList.toggle("active", b.dataset.htab === tab));
  $("homeRecent").hidden = tab !== "recent";
  $("homeTemplates").hidden = tab !== "templates";
  $("homeShared").hidden = tab !== "shared";
}

// Reopen a recent from its bytes cached in IndexedDB (the browser can't re-read
// a file by path). Bumps the entry's recency.
async function openRecent(e) {
  try {
    const bytes = await recentBytes(e.id);
    if (!bytes) { fail(new Error(`"${e.name}" is no longer available.`)); return; }
    $("docname").textContent = e.name;
    await rememberDoc({ name: e.name, bytes, path: e.path });  // copies bytes for the cache
    await openSvg(bytes);                                      // transfers (detaches) bytes
  } catch (err) { fail(err); }
}

let recentUrls = [];
async function renderRecents() {
  const wrap = $("recents");
  recentUrls.forEach(URL.revokeObjectURL);
  recentUrls = [];
  const q = ($("homeSearch")?.value || "").trim().toLowerCase();
  let list = listRecents();
  $("recentCount").textContent = list.length ? `${list.length} file${list.length === 1 ? "" : "s"}` : "Your recently opened drawings.";
  if (q) list = list.filter((e) => (e.name || "").toLowerCase().includes(q));
  if (!list.length) { wrap.innerHTML = `<div class="empty-recents">${q ? "No matching files." : "No recent files yet — open one or start a new drawing."}</div>`; return; }
  wrap.innerHTML = "";
  for (const e of list) {
    const card = document.createElement("div");
    card.className = "reccard";
    card.innerHTML = '<span class="thumb"></span><span class="meta"><div class="nm"></div><div class="ts"></div></span><button class="forget" title="Remove from recents">×</button>';
    card.querySelector(".nm").textContent = e.name;
    card.querySelector(".ts").textContent = relTime(e.ts);
    card.addEventListener("click", () => openRecent(e));
    card.querySelector(".forget").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await forgetDoc(e.id);
      renderRecents();
    });
    wrap.appendChild(card);
    recentBytes(e.id).then((bytes) => {
      if (!bytes) return;
      const url = thumbUrl(bytes);
      recentUrls.push(url);
      card.querySelector(".thumb").style.backgroundImage = `url("${url}")`;
    });
  }
}

async function openSample() {
  try {
    const res = await fetch("./sample.svg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    $("docname").textContent = "sample.svg";
    await rememberDoc({ name: "sample.svg", bytes });
    await openSvg(bytes);
  } catch (err) { fail(err); }
}

function wireHome() {
  // Going home discards the open document — warn first if it has unsaved edits.
  $("homeBtn").addEventListener("click", () => leaveGuard(showHome));
  document.querySelectorAll("#homeTabs button").forEach((b) => b.addEventListener("click", () => homeTab(b.dataset.htab)));
  $("homeSearch").addEventListener("input", renderRecents);
  $("newDrawingBtn").addEventListener("click", () => homeTab("templates"));
  for (const card of document.querySelectorAll("#homeTemplates .newcard[data-template]")) {
    card.addEventListener("click", () => newDoc(card.dataset.template));
  }
  // custom size: a px/mm unit toggle + W×H inputs feeding new-document-sized.
  let unit = "mm";
  for (const b of document.querySelectorAll("#customUnit button")) {
    b.addEventListener("click", () => {
      unit = b.dataset.unit;
      document.querySelectorAll("#customUnit button").forEach((x) => x.classList.toggle("active", x === b));
    });
  }
  $("customCreate").addEventListener("click", () => {
    const w = parseFloat($("customW").value), h = parseFloat($("customH").value);
    if (!(w > 0) || !(h > 0)) { fail(new Error("Enter a positive width and height.")); return; }
    newDocSized(w, h, unit);
  });
  $("sampleCard").addEventListener("click", openSample);
  $("homeOpen").addEventListener("click", () => $("file").click());
}

// Push a text font to every engine instance. The browser shell can't read system
// fonts the way the native shell does, so it bundles one (the `<text>` tool and
// the C5 text renderer need a face); the engine's generic-family fallback then
// resolves sans-serif/etc. to it.
// The bundled families offered by the font picker (label → CSS family + file).
const FONTS = [
  { label: "Sans", family: "DejaVu Sans", file: "DejaVuSans.ttf" },
  { label: "Serif", family: "DejaVu Serif", file: "DejaVuSerif.ttf" },
  { label: "Monospace", family: "DejaVu Sans Mono", file: "DejaVuSansMono.ttf" },
];
async function loadFonts() {
  try {
    for (const f of FONTS) {
      const bytes = new Uint8Array(await (await fetch(`./assets/${f.file}`)).arrayBuffer());
      await Promise.all(pool.map((w) => {
        const copy = bytes.slice();  // each instance needs its own (transferred) buffer
        return call(w, "addFont", { bytes: copy }, [copy.buffer]);
      }));
    }
  } catch (e) { fail(e); }
}

async function main() {
  wireRail();
  wireCanvas();
  wirePanels();
  wireTopbar();
  wireHome();
  $("nodeMod").addEventListener("click", () => setNodeRetype(!nodeRetype));
  $("nodeBreak").addEventListener("click", () =>
    call0("breakNode").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  $("nodeCombine").addEventListener("click", () =>
    call0("combineNodes").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  $("nodeLink").addEventListener("click", () =>
    call0("linkNodes").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  $("nodeSep").addEventListener("click", () =>
    call0("deleteSegment").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  $("nodeDel").addEventListener("click", () =>
    call0("deleteActiveNode").then(() => { markDocDirty(); requestRender(); refreshPanels(); }).catch(fail));
  // The home screen is visible by default (in the markup), so the editor is never
  // shown empty during pool init; recents come from storage (no pool needed), so
  // show them now. `?sample` (used by the headless probes) hides home synchronously
  // — before the first paint — and opens the bundled sample once the pool is up.
  const wantSample = new URLSearchParams(location.search).has("sample");
  if (wantSample) hideHome(); else showHome();
  await ready;                       // all pool instances initialised
  await loadFonts();                 // give every instance a text face
  if (wantSample) {
    try {
      const res = await fetch("./sample.svg");
      $("docname").textContent = "sample.svg";
      await openSvg(new Uint8Array(await res.arrayBuffer()));
    } catch (err) { fail(err); }
  } else {
    await maybeOfferRestore();        // recover unsaved work from a previous session
  }
}
try { await main(); } catch (err) { fail(err); }
