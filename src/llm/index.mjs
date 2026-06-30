// Brain selection. Returns the best available model provider, or null when no model is connected
// (the entity then runs on its deterministic router brain). Connecting a model = the last step:
// set OMNI_LLM_ENDPOINT + OMNI_LLM_MODEL (OpenAI-compatible) and the entity upgrades automatically.
import { LLM } from "../config.mjs";
import * as openai from "./openai.mjs";
import * as claude from "./claude.mjs";

const PROVIDERS = { openai, claude };

export function getProvider() {
  const pref = LLM.provider;
  if (pref === "none") return null;
  if (pref !== "auto") return PROVIDERS[pref]?.available() ? PROVIDERS[pref] : null;
  // auto: prefer the configured OpenAI-compatible endpoint, then claude.
  if (openai.available()) return openai;
  if (claude.available()) return claude;
  return null;
}

export function modelStatus() {
  const p = getProvider();
  if (p) return { connected: true, provider: p.name, model: p.name === "openai" ? LLM.model : "claude", endpoint: LLM.endpoint || undefined };
  return {
    connected: false,
    hint: "No model connected. Set OMNI_LLM_ENDPOINT + OMNI_LLM_MODEL (OpenAI-compatible) to connect one, or OMNI_ALLOW_CLAUDE=1 to use the local claude brain.",
  };
}

// Returns { connected, text, ... }. Never throws on 'no model' — callers fall back to the router.
export async function chat(messages, opts = {}) {
  const p = getProvider();
  if (!p) return { connected: false, text: null };
  try {
    const r = await p.chat(messages, opts);
    return { connected: true, ...r };
  } catch (e) {
    return { connected: false, text: null, error: e.message };
  }
}
