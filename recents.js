// recents.js — recent-files persistence for the home screen, shared verbatim by
// the web and tauri shells (the two copies are identical).
//
// Two stores, by design:
//   • localStorage `penna.recents` — an ordered (most-recent-first) array of
//     lightweight metadata `{ id, name, path, ts }`. Cheap to read on boot to
//     paint the home screen; capped at MAX entries.
//   • IndexedDB `penna` / object store `documents` — the actual SVG bytes keyed
//     by `id`, so a recent file reopens even in the browser (which can't re-read
//     a file by path) and offline. The tauri shell ALSO keeps `path`, so it can
//     prefer the live file on disk and fall back to these cached bytes.
//
// `id` is the absolute path when we have one (tauri), else `name:byteLength` — a
// stable-enough key that re-opening the same file bumps its existing entry
// rather than duplicating it. Thumbnails are free: an <img> pointing at a
// blob: URL of the bytes (browsers render SVG natively, no engine call).

const LS_KEY = "penna.recents";
const DB_NAME = "penna";
const STORE = "documents";
const MAX = 8;

// ---- IndexedDB (bytes) ------------------------------------------------------

let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbPut(id, bytes) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(bytes, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---- metadata (localStorage) ------------------------------------------------

function readMeta() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function writeMeta(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* quota — ignore */ }
}

const idFor = (name, path, len) => path || `${name}:${len}`;

// ---- public API -------------------------------------------------------------

/** The recent-file metadata, most-recent first: `[{ id, name, path, ts }]`. */
export function listRecents() {
  return readMeta();
}

/**
 * Record a freshly opened/saved document: cache its bytes (IndexedDB) and move
 * its metadata to the front of the list (capped at MAX). `path` is optional
 * (tauri only). `ts` is set to now. Returns the entry.
 */
export async function rememberDoc({ name, bytes, path }) {
  const id = idFor(name, path, bytes.length);
  try { await idbPut(id, bytes.slice()); } catch { /* IDB unavailable — metadata still useful */ }
  const ts = Date.now();
  const entry = { id, name, path: path || null, ts };
  let list = readMeta().filter((e) => e.id !== id);
  list.unshift(entry);
  // Drop bytes for entries that fall off the end.
  for (const dropped of list.slice(MAX)) idbDelete(dropped.id).catch(() => {});
  list = list.slice(0, MAX);
  writeMeta(list);
  return entry;
}

/** The cached bytes for a recent `id`, or null if not present. */
export async function recentBytes(id) {
  try { return await idbGet(id); } catch { return null; }
}

/** Remove a recent entry (metadata + cached bytes). */
export async function forgetDoc(id) {
  writeMeta(readMeta().filter((e) => e.id !== id));
  await idbDelete(id).catch(() => {});
}

/** A blob: URL that renders `bytes` as an SVG (for an <img> thumbnail). The
 *  caller should URL.revokeObjectURL it when the card is discarded. */
export function thumbUrl(bytes) {
  return URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
}

// ---- recovery draft ---------------------------------------------------------
// A single autosaved snapshot of the working document so unsaved work survives a
// crash / accidental reload. The web shell relies on it as its ONLY autosave (a
// browser can't silently write to disk); the tauri shell uses it as a safety net
// alongside writing back to the open file. Stored like a recent (bytes in IDB,
// metadata in localStorage) but under a reserved key so it never appears in the
// recents list.
const DRAFT_KEY = "penna.draft";
const DRAFT_ID = "__draft__";

/** Autosave the working document as the recovery draft. `path` is optional. */
export async function saveDraft({ name, bytes, path }) {
  try { await idbPut(DRAFT_ID, bytes.slice()); } catch { return; }  // IDB unavailable
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: name || "document.svg", path: path || null, ts: Date.now() }));
  } catch { /* quota — ignore */ }
}

/** The recovery draft `{ name, path, ts, bytes }`, or null if there is none. */
export async function loadDraft() {
  let meta;
  try { meta = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { meta = null; }
  if (!meta) return null;
  const bytes = await recentBytes(DRAFT_ID);
  if (!bytes) return null;
  return { ...meta, bytes };
}

/** Discard the recovery draft (after a clean save, or when the user declines). */
export async function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  await idbDelete(DRAFT_ID).catch(() => {});
}

/** A short relative-time label ("just now", "3h ago", "2d ago") for a `ts`. */
export function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
