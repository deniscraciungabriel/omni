// Suppress Node's ExperimentalWarning for node:sqlite so operator output stays clean.
// Import this FIRST in entrypoints (side-effect module, no exports).
const origEmit = process.emit;
process.emit = function (name, data, ...rest) {
  if (
    name === "warning" &&
    data &&
    typeof data === "object" &&
    data.name === "ExperimentalWarning" &&
    /SQLite|node:sqlite/i.test(String(data.message))
  ) {
    return false;
  }
  return origEmit.call(this, name, data, ...rest);
};
