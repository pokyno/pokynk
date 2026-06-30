// Render worker (WP-B4): hosts an editor_core.wasm component instance off the
// main thread. The shell runs a POOL of these: worker 0 is authoritative (holds
// the document + selection, handles all events and hit-testing); the rest are
// document rasterizers that render tiles of the settle frame in parallel. All
// expensive work (load, edits, rasterization) happens here, never on the UI
// thread, and pixel buffers are transferred (zero-copy) back.
//
// Pure request/response RPC: each message has an id; the reply carries the same
// id. The static import has a top-level await (wasm init) in the jco glue, so no
// message is processed until the component is ready (browser buffers them).
import * as editor from "./generated/editor_core.js";

// Build-freshness probe: `break-node` is the newest engine export, so its
// presence proves `generated/` was re-transpiled from a current component. If
// this logs `false`, the browser is running a STALE engine (re-run the build:
// cargo component build, then jco transpile, then hard-reload past the wasm cache).
console.log("[engine] fresh build:", typeof editor.breakNode === "function");

const tile = (f) => ({ data: f.data, width: f.size.width, height: f.size.height });

const H = {
  load: (a) => { editor.load(a.bytes); },
  newDocument: (a) => { editor.newDocument(a.template); },
  newDocumentSized: (a) => { editor.newDocumentSized(a.width, a.height, a.unit); },
  setDocumentSize: (a) => editor.setDocumentSize(a.width, a.height, a.unit),
  setPageColor: (a) => editor.setPageColor(a.color),
  addFont: (a) => { editor.addFont(a.bytes); },
  documentBounds: () => editor.documentBounds(),
  documentTree: () => editor.documentTree(),
  documentInfo: () => editor.documentInfo(),
  selectionBounds: () => editor.selectionBounds(),
  setSelectionBounds: (a) => editor.setSelectionBounds(a.b),
  setTool: (a) => { editor.setTool(a.id); },
  setView: (a) => { editor.setView(a.viewport, a.size); },
  handlePointer: (a) => editor.handlePointer(a.ev),
  handleKey: (a) => editor.handleKey(a.ev),
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  setFill: (a) => editor.setFill(a.color),
  setStroke: (a) => editor.setStroke(a.color),
  setStrokeWidth: (a) => editor.setStrokeWidth(a.width),
  setStyleProperty: (a) => editor.setStyleProperty(a.property, a.value),
  align: (a) => editor.align(a.mode, a.relativeTo || "selection"),
  distribute: (a) => editor.distribute(a.mode),
  setSnapping: (a) => { editor.setSnapping(a.on); },
  setNodeRetype: (a) => { editor.setNodeRetype(a.on); },
  toPath: () => editor.toPath(),
  embedImage: (a) => editor.embedImage(a.href, a.width, a.height),
  selectNode: (a) => editor.selectNode(a.node),
  deleteActiveNode: () => editor.deleteActiveNode(),
  deleteSelection: () => editor.deleteSelection(),
  breakNode: () => editor.breakNode(),
  combineNodes: () => editor.combineNodes(),
  linkNodes: () => editor.linkNodes(),
  deleteSegment: () => editor.deleteSegment(),
  selectInPolygon: (a) => editor.selectInPolygon(a.points),
  enterGroup: (a) => editor.enterGroup(a.point),
  pathBoolean: (a) => editor.pathBoolean(a.op),
  setFillGradient: (a) => editor.setFillGradient(a.kind),
  group: () => editor.group(),
  ungroup: () => editor.ungroup(),
  reorder: (a) => editor.reorder(a.op),
  computedStyle: (a) => editor.computedStyle(a.node, a.property),
  setLayerVisible: (a) => editor.setLayerVisible(a.id, a.visible),
  setLayerLocked: (a) => editor.setLayerLocked(a.id, a.locked),
  createLayer: (a) => editor.createLayer(a.label),
  createSublayer: (a) => editor.createSublayer(a.parent, a.label),
  reorderLayer: (a) => editor.reorderLayer(a.id, a.op),
  moveToLayer: (a) => editor.moveToLayer(a.layer),
  deleteLayer: (a) => editor.deleteLayer(a.id),
  setLayerOpacity: (a) => editor.setLayerOpacity(a.id, a.opacity),
  setLayerLabel: (a) => editor.setLayerLabel(a.id, a.label),
  save: () => editor.save(),
  // Full-resolution cached render (WP-C3 pixmap cache + WP-C5 incremental + the
  // selection overlay): pan/zoom within the cache margin re-projects the cached
  // full-res pixels (no re-rasterization, no resolution drop), and an edit
  // re-rasterizes only the changed element. Used for interaction frames.
  render: (a) => tile(editor.render(a.viewport, a.size, a.maxDownscale)),
  // Document-only exact rasterization of a sub-viewport (no cache margin).
  renderTile: (a) => tile(editor.renderTile(a.viewport, a.size)),
  // Overlay-only transparent layer for compositing over the tiled document.
  renderOverlay: (a) => tile(editor.renderOverlay(a.viewport, a.size)),
  // Live drag preview (Inkscape-style): the static background (document minus
  // the selection) and the moving sprite (only the selection), captured once at
  // drag start so the drag re-composites client-side without re-rendering.
  renderWithoutSelection: (a) => tile(editor.renderWithoutSelection(a.viewport, a.size)),
  renderBelowSelection: (a) => tile(editor.renderBelowSelection(a.viewport, a.size)),
  renderAboveSelection: (a) => tile(editor.renderAboveSelection(a.viewport, a.size)),
  renderSelectionSprite: (a) => tile(editor.renderSelectionSprite(a.viewport, a.size)),
  // Which gesture the down armed: "move" → slide the sprite; "scale"/"rotate"/
  // "node"/"gradient" → re-render the sprite each frame; "" → no drag.
  dragKind: () => editor.dragKind(),
  selectionOccluded: () => editor.selectionOccluded(),
};

self.onmessage = (e) => {
  const { id, method, args } = e.data;
  try {
    const fn = H[method];
    if (!fn) throw new Error("unknown method: " + method);
    const result = fn(args || {});
    let transfer = [];
    if (["render", "renderTile", "renderOverlay", "renderWithoutSelection", "renderBelowSelection", "renderAboveSelection", "renderSelectionSprite"].includes(method) && result) transfer = [result.data.buffer];
    else if (method === "save" && result) transfer = [result.buffer];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};

self.postMessage({ type: "ready" });
