// Browser WASI stubs for wasi:cli (WP-B4). See shim/io.js.
import { InputStream, OutputStream } from "./io.js";

const stderrStream = new OutputStream();
const stdoutStream = new OutputStream();
const stdinStream = new InputStream();

export const environment = {
  getEnvironment: () => [],
  getArguments: () => [],
  initialCwd: () => undefined,
};

export const exit = { exit: () => {} };

export const stderr = { getStderr: () => stderrStream };
export const stdout = { getStdout: () => stdoutStream };
export const stdin = { getStdin: () => stdinStream };

class TerminalInput {}
class TerminalOutput {}

export const terminalInput = { TerminalInput };
export const terminalOutput = { TerminalOutput };
// `get-terminal-*` return option<terminal-…>; `undefined` is the `none` case
// (we are not a terminal).
export const terminalStderr = { getTerminalStderr: () => undefined };
export const terminalStdin = { getTerminalStdin: () => undefined };
export const terminalStdout = { getTerminalStdout: () => undefined };
