// The entity's turn loop. Every message is persisted (durable memory). Confident skill intents
// run deterministically (reliable tools); open-ended messages are answered by the connected model
// if there is one, else a graceful "connect a model" fallback. Connecting a model is the last step
// that turns free-form requests from "can't act" into real answers.
import { latestConversation, startConversation, addMessage, recentTurns } from "./conversation.mjs";
import { classify, route } from "./router.mjs";
import { getProvider, chat } from "../llm/index.mjs";
import { getIdentity, getUserProfile } from "./identity.mjs";
import { ensureProject } from "../memory/memory.mjs";
import { emit } from "../events.mjs";

function systemPrompt() {
  const id = getIdentity();
  const prof = getUserProfile();
  return (
    `${id.persona}\nYou are ${id.name}.` +
    (prof.name ? ` You are talking with ${prof.name}.` : "") +
    ` Be concise and direct. You can run specialized harnesses (contract, finance, incident, research), ` +
    `create and run tasks, remember durable facts, scan for problems, evolve behind evals, and report status. ` +
    `If the user's request maps to one of those, tell them the exact phrasing to trigger it.`
  );
}

export async function converse(input, { conversationId, newConversation = false } = {}) {
  ensureProject("entity", { title: "Entity memory", description: "Conversation + preference memory for the entity." });
  const cid = conversationId || (newConversation ? startConversation() : latestConversation());
  addMessage(cid, "user", input);

  const c = classify(input);
  let reply, intent = c.intent, via = "router";

  if (c.handler) {
    reply = await c.handler(c.match, input);
  } else {
    const provider = getProvider();
    if (provider) {
      const turns = recentTurns(cid, 8).map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: t.content }));
      const res = await chat([{ role: "system", content: systemPrompt() }, ...turns]);
      if (res.connected && res.text) { reply = res.text.trim(); via = "model:" + (res.provider || "llm"); }
      else { reply = (await route(input)).text; via = "router-fallback"; }
    } else {
      reply = (await route(input)).text;
      via = "router-fallback";
    }
  }

  addMessage(cid, "assistant", reply, { intent, meta: { via } });
  emit("entity.turn", { message: `${intent} via ${via}`, data: { intent, via } });
  return { reply, intent, via, conversationId: cid };
}
