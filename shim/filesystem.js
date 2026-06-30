// Browser WASI stubs for wasi:filesystem (WP-B4). The component has no
// filesystem; documents/fonts cross the WIT boundary as bytes. See shim/io.js.
class Descriptor {}

export const preopens = { getDirectories: () => [] };
export const types = {
  Descriptor,
  filesystemErrorCode: () => undefined,
};
