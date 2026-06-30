// Browser WASI stubs for wasi:random (WP-B4). Backed by the Web Crypto API. See
// shim/io.js.
export const random = {
  getRandomBytes: (len) => {
    const n = Number(len);
    const bytes = new Uint8Array(n);
    // crypto.getRandomValues caps at 65536 bytes per call.
    for (let off = 0; off < n; off += 65536) {
      globalThis.crypto?.getRandomValues(bytes.subarray(off, Math.min(off + 65536, n)));
    }
    return bytes;
  },
  getRandomU64: () => {
    const b = new Uint8Array(8);
    globalThis.crypto?.getRandomValues(b);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[i]);
    return v;
  },
};
