# Connecting a model — the last step

omni (the entity **Omni**) runs **fully today** on a deterministic router brain: you talk to it,
it does real work (harnesses, sagas, tasks, memory, status, self-improvement), remembers, and
evolves. The one remaining capability is **free-form natural-language understanding** — answering
open-ended requests that don't map to a built-in skill. That comes from connecting a model.

The model layer is already built and tested (dormant). Connecting one is a **config-only step** —
no code changes. Point omni at any server that speaks the OpenAI **`/v1/chat/completions`** API.

## Option A — an open-source model on an OpenAI-compatible endpoint (the intended path)

Works with **Ollama, vLLM, LM Studio, llama.cpp server, text-generation-webui, OpenRouter, …**

```bash
# 1. Run your model server (examples)
#    Ollama:     ollama serve            # then: ollama pull llama3.1
#    vLLM:       python -m vllm.entrypoints.openai.api_server --model <hf-model>
#    LM Studio:  start its local server (OpenAI-compatible)

# 2. Tell the entity where it is (these are the only switches that matter)
export OMNI_LLM_ENDPOINT="http://localhost:11434/v1"   # your server's base URL
export OMNI_LLM_MODEL="llama3.1"                        # the served model name
export OMNI_LLM_API_KEY=""                              # if your server needs one

# 3. Talk to it — it now understands open-ended requests
node bin/omni.mjs chat
```

Verify the brain is connected:
```bash
node bin/omni.mjs model      # -> connected via openai (llama3.1) @ http://localhost:11434/v1
```

## Option B — the local Claude CLI as the brain (for testing)
```bash
export OMNI_ALLOW_CLAUDE=1
node bin/omni.mjs model      # -> connected via claude
```

## What changes when a model is connected
- **Before:** built-in skills work (status, harnesses, memory, scan, evolve, …); anything else →
  "connect a model" fallback.
- **After:** the same skills still run deterministically (reliable tools), AND open-ended messages
  are answered by the model. Conversation history + your remembered facts are sent as context.

## Env reference
| var | meaning |
|---|---|
| `OMNI_LLM_ENDPOINT` | OpenAI-compatible base URL (with or without `/chat/completions`) |
| `OMNI_LLM_MODEL` | model name the server expects |
| `OMNI_LLM_API_KEY` | bearer token, if required |
| `OMNI_LLM_PROVIDER` | `auto` (default) · `openai` · `claude` · `none` |
| `OMNI_LLM_MAX_TOKENS` / `OMNI_LLM_TEMPERATURE` | generation params |
| `OMNI_ENTITY_NAME` | rename the entity (default `Omni`) |

That's it — there is no other integration work. The adapter (`src/llm/`), the entity
(`src/agent/`), memory, and evolution are all in place and eval-covered.
