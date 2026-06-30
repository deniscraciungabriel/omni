// Control plane: hybrid HTTP API (REST for state/CRUD) + SSE (live event feed) + a single-page
// dashboard. Cross-process safe: the live feed polls the shared events table, so a worker
// running in another terminal still streams here. This is the human-facing operating surface.
import http from "node:http";
import { all, get } from "../db.mjs";
import { statusReport, metricsSummary } from "../status.mjs";
import { listTasks } from "../core/tasks.mjs";
import { listGoals } from "../core/goals.mjs";
import { allQueues, syncQueues } from "../core/queues.mjs";
import { pendingApprovals, decideApproval, listTrust } from "../core/governance.mjs";
import { planFromPlaybook, planFreeform, planFreeformLLM } from "../core/planner.mjs";
import { runLoop } from "../worker/worker.mjs";
import { proactiveScan } from "../improve/scan.mjs";
import { taskView, goalView, projectView, portfolioView, sessionView } from "../core/views.mjs";
import { listRecurring, cronTick, ensureRecurringDefaults } from "../core/recurring.mjs";
import { DASHBOARD_HTML } from "./dashboard.mjs";
import { log } from "../log.mjs";

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

export function startServer(port = 7777) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    try {
      // --- dashboard ---
      if (p === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(DASHBOARD_HTML);
      }

      // --- live event feed (SSE, DB-polled => cross-process) ---
      if (p === "/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        let lastTs = new Date().toISOString();
        const timer = setInterval(() => {
          const rows = all(`SELECT * FROM events WHERE ts > ? ORDER BY ts ASC LIMIT 50`, lastTs);
          for (const ev of rows) {
            lastTs = ev.ts;
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }
        }, 1000);
        req.on("close", () => clearInterval(timer));
        return;
      }

      // --- REST API ---
      if (p === "/api/status") return json(res, 200, statusReport());
      if (p === "/api/metrics") return json(res, 200, metricsSummary());
      if (p === "/api/tasks") return json(res, 200, listTasks(url.searchParams.get("status") ? { status: url.searchParams.get("status") } : {}));
      if (p === "/api/goals") return json(res, 200, listGoals());
      if (p === "/api/queues") { syncQueues(); return json(res, 200, allQueues()); }
      if (p === "/api/approvals") return json(res, 200, pendingApprovals());
      if (p === "/api/trust") return json(res, 200, listTrust());
      if (p === "/api/events") return json(res, 200, all(`SELECT * FROM events ORDER BY ts DESC LIMIT 60`));
      if (p === "/api/portfolio") return json(res, 200, portfolioView());
      if (p === "/api/recurring") return json(res, 200, listRecurring());

      // --- altitude drill-down (session -> task -> goal -> project) ---
      let mm;
      if ((mm = p.match(/^\/api\/task\/(.+)$/))) return json(res, 200, taskView(decodeURIComponent(mm[1])) || { error: "not found" });
      if ((mm = p.match(/^\/api\/goal\/(.+)$/))) return json(res, 200, goalView(decodeURIComponent(mm[1])) || { error: "not found" });
      if ((mm = p.match(/^\/api\/project\/(.+)$/))) return json(res, 200, projectView(decodeURIComponent(mm[1])) || { error: "not found" });
      if ((mm = p.match(/^\/api\/session\/(.+)$/))) return json(res, 200, sessionView(decodeURIComponent(mm[1])) || { error: "not found" });

      if (p === "/api/cron-tick" && req.method === "POST") {
        ensureRecurringDefaults();
        return json(res, 200, { ran: await cronTick() });
      }

      if (p === "/api/goal" && req.method === "POST") {
        const body = await readBody(req);
        const r = body.playbook
          ? planFromPlaybook(body.playbook, {})
          : body.single
            ? planFreeform(body.description || "", {})
            : planFreeformLLM(body.description || "", {});
        syncQueues();
        return json(res, 200, r);
      }
      if (p === "/api/run" && req.method === "POST") {
        const results = await runLoop("dashboard-worker", { maxTicks: 200 });
        return json(res, 200, { runs: results.length, results });
      }
      if (p === "/api/scan" && req.method === "POST") {
        return json(res, 200, { created: proactiveScan() });
      }
      if (p === "/api/say" && req.method === "POST") {
        const body = await readBody(req);
        const { converse } = await import("../agent/converse.mjs");
        const r = await converse(body.message || "", body.conversationId ? { conversationId: body.conversationId } : {});
        return json(res, 200, r);
      }
      if (p === "/api/model") {
        const { modelStatus } = await import("../llm/index.mjs");
        return json(res, 200, modelStatus());
      }
      const m = p.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
      if (m && req.method === "POST") {
        decideApproval(m[1], m[2] === "approve" ? "approved" : "denied", "dashboard");
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: "not found", path: p });
    } catch (e) {
      json(res, 500, { error: e.message, stack: e.stack });
    }
  });

  server.listen(port, () => {
    log.ok(`omni control plane on http://localhost:${port}`);
    log.dim("  dashboard: /   ·  api: /api/status  ·  live: /events");
    log.dim("  Ctrl+C to stop.");
  });
  return server;
}
