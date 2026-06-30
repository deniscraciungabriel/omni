// Experiment registry for the research harness. Experiments are DETERMINISTIC given a seed
// (seeded PRNG), which is what makes reproducibility verifiable: same manifest -> same result.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { checksum } from "../../ids.mjs";

// mulberry32: small, fast, deterministic PRNG seeded by an integer.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const EXPERIMENTS = {
  // Estimate π via Monte Carlo. trueValue is the reference for error/uncertainty.
  monte_carlo_pi: {
    trueValue: Math.PI,
    metric: "pi_estimate",
    run(params, seed) {
      const rng = mulberry32(seed);
      const n = params.samples || 10000;
      let inside = 0;
      for (let i = 0; i < n; i++) { const x = rng(), y = rng(); if (x * x + y * y <= 1) inside++; }
      return { estimate: (4 * inside) / n, samples: n, inside };
    },
  },
  // Sample mean of a seeded uniform[0,1] stream; trueValue 0.5.
  mean_uniform: {
    trueValue: 0.5,
    metric: "sample_mean",
    run(params, seed) {
      const rng = mulberry32(seed);
      const n = params.samples || 10000;
      let s = 0;
      for (let i = 0; i < n; i++) s += rng();
      return { estimate: s / n, samples: n };
    },
  },
};

// Lineage: a content hash of this experiment code. A change here would change the manifest rev,
// flagging that prior results are no longer reproducible from the current code.
export function codeRev() {
  try { return checksum(fs.readFileSync(fileURLToPath(import.meta.url))).slice(0, 16); }
  catch { return "unknown"; }
}
