// Research/science harness — pure phase logic. Separates hypothesis / method / result /
// interpretation, captures lineage (manifest), states uncertainty, and — critically — verifies
// REPRODUCIBILITY by re-running from the same manifest and comparing.
import { nowIso } from "../../config.mjs";
import { EXPERIMENTS, codeRev } from "./experiments.mjs";

const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Phase 2 — design: validate the spec, build a reproducible environment manifest (lineage).
export function design(spec) {
  const exp = EXPERIMENTS[spec.method];
  const errors = [];
  if (!exp) errors.push(`unknown method: ${spec.method}`);
  if (!Array.isArray(spec.params?.seeds) || !spec.params.seeds.length) errors.push("params.seeds required");
  if (!spec.params?.samples) errors.push("params.samples required");
  const manifest = {
    method: spec.method,
    params: spec.params,
    code_rev: codeRev(),
    node: process.version,
    created: nowIso(),
  };
  return { valid: errors.length === 0, errors, manifest, metric: exp?.metric || null };
}

// Phase 3 — run across seeds (deterministic). Returns per-seed results.
export function runExperiment(manifest) {
  const exp = EXPERIMENTS[manifest.method];
  const results = manifest.params.seeds.map((seed) => ({ seed, ...exp.run(manifest.params, seed) }));
  return { method: manifest.method, code_rev: manifest.code_rev, results, at: nowIso() };
}

// Phase 4 — analyze: point estimate + uncertainty + error vs reference.
export function analyze(runRes) {
  const exp = EXPERIMENTS[runRes.method];
  const estimates = runRes.results.map((r) => r.estimate);
  const m = mean(estimates), sd = std(estimates);
  const trueValue = exp.trueValue;
  return {
    metric: exp.metric,
    n_runs: estimates.length,
    estimate_mean: +m.toFixed(6),
    estimate_std: +sd.toFixed(6),
    true_value: +trueValue.toFixed(6),
    abs_error: +Math.abs(m - trueValue).toFixed(6),
    // simple 95% interval (normal approx) — an explicit uncertainty statement
    ci95: [+(m - 1.96 * sd).toFixed(6), +(m + 1.96 * sd).toFixed(6)],
    at: nowIso(),
  };
}

// Phase 5 — reproduce: re-run independently from the SAME manifest, compare to the stored run.
// A claim is only accepted if it reproduces. Detects drift in code/params/results.
export function reproduce(manifest, originalRun, tol = 1e-12) {
  const fresh = runExperiment(manifest);
  if (fresh.code_rev !== originalRun.code_rev) {
    return { reproducible: false, reason: "code_rev changed since original run", maxDiff: null };
  }
  let maxDiff = 0;
  for (let i = 0; i < fresh.results.length; i++) {
    const a = fresh.results[i]?.estimate, b = originalRun.results[i]?.estimate;
    if (a == null || b == null) return { reproducible: false, reason: "result count mismatch", maxDiff: null };
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
  }
  return { reproducible: maxDiff <= tol, maxDiff, tol, at: nowIso() };
}

// Phase 6 — templated experiment report (claim -> evidence, with uncertainty + reproducibility).
export function report(spec, design, analysis, repro) {
  return `# Experiment Report — ${spec.question || spec.method}
_Generated ${nowIso()} · omni research harness_

## Hypothesis
${spec.hypothesis || "_(none stated)_"}

## Method
- Method: **${spec.method}** · samples/run: ${spec.params.samples} · runs (seeds): ${spec.params.seeds.length}
- Lineage: code_rev \`${design.manifest.code_rev}\` · node ${design.manifest.node}

## Result (with uncertainty)
- ${analysis.metric}: **${analysis.estimate_mean} ± ${analysis.estimate_std}** (95% CI ${JSON.stringify(analysis.ci95)})
- Reference value: ${analysis.true_value} · absolute error: **${analysis.abs_error}**

## Reproducibility
- Independent re-run from the same manifest: **${repro.reproducible ? "REPRODUCED" : "NOT REPRODUCED"}**${repro.reason ? ` (${repro.reason})` : ` (max diff ${repro.maxDiff})`}

## Interpretation
${repro.reproducible
      ? `The estimate is reproducible from the versioned manifest. The ${analysis.abs_error <= analysis.estimate_std + 0.02 ? "result is consistent with" : "result deviates from"} the reference within stated uncertainty.`
      : "Result did not reproduce — do NOT rely on it until the discrepancy is resolved."}

## Claim → evidence
- Claim: ${spec.method} estimate ≈ ${analysis.estimate_mean}
- Evidence: ${analysis.n_runs} seeded runs; reproducible=${repro.reproducible}; artifacts 03-run.json / 04-analysis.json / 05-repro.json
`;
}
