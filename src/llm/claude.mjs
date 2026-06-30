// Claude chat adapter — uses the already-present `claude` CLI as a brain (read-only: plan mode,
// so conversation never edits files). Available only when OMNI_ALLOW_CLAUDE=1. A convenient
// brain for testing the entity before an open-source endpoint is wired in.
import { POLICY } from "../config.mjs";
import { callClaude } from "../executors/claude.mjs";

export const name = "claude";

export function available() {
  return POLICY.allowClaude;
}

export async function chat(messages, opts = {}) {
  const prompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n") + "\n\nASSISTANT:";
  const r = callClaude(prompt, { permissionMode: "plan", ...opts });
  if (r.gated) throw new Error("claude brain gated (set OMNI_ALLOW_CLAUDE=1)");
  if (!r.ok) throw new Error(r.error || "claude chat failed");
  return { text: r.text, model: "claude", usage: { tokens: r.tokens }, cost: r.cost, provider: "claude" };
}
