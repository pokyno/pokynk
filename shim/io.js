// Browser WASI stubs (WP-B4): the engine does no real I/O at runtime, so these
// satisfy the jco-generated import asserts without Node's preview2-shim (which
// needs node: builtins). An import map in index.html redirects
// `@bytecodealliance/preview2-shim/*` here. Members mirror what the generated
// glue destructures; functions return sane values and are mostly never called.

export class IoError {
  constructor(message = "io error") {
    this.message = message;
  }
  toDebugString() {
    return this.message;
  }
}

export class InputStream {
  read() {
    return new Uint8Array(0);
  }
  blockingRead() {
    return new Uint8Array(0);
  }
  skip() {
    return 0n;
  }
  blockingSkip() {
    return 0n;
  }
  subscribe() {
    return { ready: () => true, block: () => {} };
  }
}

export class OutputStream {
  checkWrite() {
    return 1n << 20n; // a large, always-available write budget
  }
  write() {}
  blockingWrite() {}
  blockingWriteAndFlush() {}
  flush() {}
  blockingFlush() {}
  subscribe() {
    return { ready: () => true, block: () => {} };
  }
}

export const error = { Error: IoError };
export const streams = { InputStream, OutputStream };
