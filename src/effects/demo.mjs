// Demo for the effect layer: a customer-onboarding saga that mutates three simulated external
// systems (CRM, billing, email). Used by evals (fresh in-memory systems) and the CLI (file-backed
// systems so partial-failure rollback is observable). opts.failAt makes a given step's external
// call throw, to demonstrate compensation.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.mjs";

export function newSystems() {
  return { crm: { records: {} }, billing: { accounts: {} }, email: { sent: [] } };
}

export function buildOnboardSteps(systems, customer, opts = {}) {
  const fail = (i) => opts.failAt === i;
  const k = customer.email;
  return [
    {
      kind: "crm.create", keyParts: [k], payload: { customer },
      do: () => { if (fail(0)) throw new Error("CRM unavailable"); systems.crm.records[k] = { ...customer }; return { crmId: "crm_" + k }; },
      compensate: () => { delete systems.crm.records[k]; },
    },
    {
      kind: "billing.create", keyParts: [k], payload: { customer },
      do: () => { if (fail(1)) throw new Error("billing API 500"); systems.billing.accounts[k] = { plan: customer.plan || "free" }; return { acct: "acct_" + k }; },
      compensate: () => { delete systems.billing.accounts[k]; },
    },
    {
      kind: "email.welcome", keyParts: [k], payload: { customer },
      do: () => { if (fail(2)) throw new Error("SMTP timeout"); systems.email.sent.push(k); return { sent: true }; },
      compensate: () => { const i = systems.email.sent.indexOf(k); if (i >= 0) systems.email.sent.splice(i, 1); },
    },
  ];
}

export function summarize(systems) {
  return {
    crm_records: Object.keys(systems.crm.records).length,
    billing_accounts: Object.keys(systems.billing.accounts).length,
    emails_sent: systems.email.sent.length,
  };
}

const STORE = path.join(PATHS.state, "effects-demo.json");
export function loadSystems() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return newSystems(); }
}
export function saveSystems(s) {
  fs.mkdirSync(PATHS.state, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2));
}
