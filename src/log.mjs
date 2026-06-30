// Tiny console logger with consistent, scannable operator output.
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function c(color, s) {
  return useColor ? color + s + C.reset : s;
}

export const log = {
  info: (m) => console.log(c(C.cyan, "·"), m),
  step: (m) => console.log(c(C.blue, "▸"), m),
  ok: (m) => console.log(c(C.green, "✓"), m),
  warn: (m) => console.log(c(C.yellow, "!"), m),
  err: (m) => console.log(c(C.red, "✗"), m),
  dim: (m) => console.log(c(C.gray, m)),
  head: (m) => console.log("\n" + c(C.bold, m)),
  raw: (m) => console.log(m),
};
export { c, C };
