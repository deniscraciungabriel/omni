// OpenAI-compatible chat adapter. THE intended "connect a model" target: point OMNI_LLM_ENDPOINT
// at any server speaking POST /chat/completions (vLLM, Ollama /v1, LM Studio, llama.cpp server,
// OpenAI, OpenRouter, ...). Built on Node's global fetch — zero dependencies.
import { LLM } from "../config.mjs";

export const name = "openai";

export function available() {
  return !!LLM.endpoint && !!LLM.model;
}

export async function chat(messages, opts = {}) {
  const base = LLM.endpoint.replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const headers = { "content-type": "application/json" };
  if (LLM.apiKey) headers.authorization = `Bearer ${LLM.apiKey}`;
  const body = {
    model: LLM.model,
    messages,
    max_tokens: opts.maxTokens || LLM.maxTokens,
    temperature: opts.temperature ?? LLM.temperature,
    stream: false,
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`LLM endpoint ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    model: data.model || LLM.model,
    usage: data.usage || null,
    provider: "openai",
  };
}
