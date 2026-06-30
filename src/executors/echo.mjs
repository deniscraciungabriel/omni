// Echo executor: side-effect-free, deterministic. Used by the eval harness to exercise the
// full loop (claim -> execute -> verify -> evidence) without touching the filesystem or LLM.
export const name = "echo";
export const handles = ["echo"];

export async function execute(task, _ctx) {
  const spec = task.spec || {};
  if (spec.fail) return { ok: false, exitCode: 1, summary: `echo forced failure: ${spec.echo || ""}` };
  return { ok: true, exitCode: 0, summary: `echo: ${spec.echo ?? task.title}`, artifacts: [] };
}
