// Assistant evaluation runner.
//
//   npm run eval:assistant                 # current engine
//   npm run eval:assistant -- --engine <path/to/engine.ts> --json out.json
//
// Replays every case in cases.ts against an in-memory, permission-aware
// database (fake-db.ts) the way the chat widget would (it carries the
// conversation context from one reply to the next) and reports pass rates per
// capability, data-leak failures and latency. No network, no model: token
// cost of the local pipeline is 0 by construction.

import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { CASES, FORGED_CONTEXT, type EvalCase, type EvalReply, type Group } from "./cases.ts";
import { HOLDOUT } from "./cases-holdout.ts";
import { FakeDb } from "./fake-db.ts";

const NOW = new Date("2026-10-12T03:00:00Z");

type AnswerFn = (request: Record<string, unknown>, deps: Record<string, unknown>) => Promise<EvalReply>;

export type CaseResult = {
  id: string;
  group: Group;
  passed: boolean;
  checks: { turn: number; name: string; ok: boolean; leak: boolean }[];
  latencies: number[];
  error?: string;
};

export type EvalReport = {
  cases: CaseResult[];
  groups: Record<string, { cases: number; passed: number; checks: number; checksPassed: number }>;
  totals: {
    cases: number;
    passed: number;
    checks: number;
    checksPassed: number;
    leakFailures: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    llmCalls: number;
  };
};

export const CASE_SETS: Record<string, EvalCase[]> = { main: CASES, holdout: HOLDOUT, all: [...CASES, ...HOLDOUT] };

export async function runEval(
  answer: AnswerFn,
  options: { verbose?: boolean; cases?: EvalCase[]; deps?: Record<string, unknown> } = {}
): Promise<EvalReport> {
  const results: CaseResult[] = [];
  let llmCalls = 0;
  for (const c of options.cases ?? CASES) {
    const db = new FakeDb();
    const history: EvalReply[] = [];
    const result: CaseResult = { id: c.id, group: c.group, passed: true, checks: [], latencies: [] };
    const forged = FORGED_CONTEXT[c.id];
    let contextFileId: string | null = forged?.contextFileId ?? null;
    let context: unknown = forged?.context ?? null;
    for (const [i, turn] of c.turns.entries()) {
      turn.before?.(db);
      const deps = {
        now: NOW,
        rpc: db.rpcFor(c.user),
        memory: db.memoryStore(c.user),
        findFolders: db.findFolders(c.user),
        signAction: (payload: unknown) => `signed:${JSON.stringify(payload).length}`,
        onLlmCall: () => {
          llmCalls += 1;
        },
        ...options.deps,
      };
      let reply: EvalReply;
      const t0 = performance.now();
      try {
        reply = await answer({ message: turn.say, page: 1, contextFileId, context }, deps);
      } catch (error) {
        reply = { intent: "error", text: String(error) };
        result.error = `${turn.say}: ${error instanceof Error ? error.message : String(error)}`;
      }
      result.latencies.push(performance.now() - t0);
      for (const chk of turn.expect) {
        let ok = false;
        try {
          ok = chk.run(reply, { db, user: c.user, history });
        } catch {
          ok = false;
        }
        result.checks.push({ turn: i + 1, name: chk.name, ok, leak: Boolean(chk.leak) });
        if (!ok) result.passed = false;
      }
      if (options.verbose) {
        const failed = result.checks.filter((x) => x.turn === i + 1 && !x.ok);
        console.log(`  ${failed.length ? "✗" : "✓"} [${c.id}#${i + 1}] ${turn.say}${failed.length ? `  → ${failed.map((f) => f.name).join("; ")}` : ""}`);
        if (failed.length && process.env.EVAL_DEBUG) console.log("    ", JSON.stringify(reply).slice(0, 600));
      }
      history.push(reply);
      // The widget keeps the newest context; the previous widget only kept a file id.
      if (reply.context !== undefined) context = reply.context;
      if (reply.contextFileId) contextFileId = reply.contextFileId;
    }
    results.push(result);
  }

  const groups: EvalReport["groups"] = {};
  for (const r of results) {
    const g = (groups[r.group] ??= { cases: 0, passed: 0, checks: 0, checksPassed: 0 });
    g.cases += 1;
    g.passed += r.passed ? 1 : 0;
    g.checks += r.checks.length;
    g.checksPassed += r.checks.filter((x) => x.ok).length;
  }
  const latencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const checks = results.flatMap((r) => r.checks);
  return {
    cases: results,
    groups,
    totals: {
      cases: results.length,
      passed: results.filter((r) => r.passed).length,
      checks: checks.length,
      checksPassed: checks.filter((x) => x.ok).length,
      leakFailures: checks.filter((x) => x.leak && !x.ok).length,
      avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / Math.max(latencies.length, 1),
      p95LatencyMs: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
      llmCalls,
    },
  };
}

const pct = (a: number, b: number) => `${b ? Math.round((a / b) * 100) : 0}%`;

export function formatReport(report: EvalReport): string {
  const lines = ["capability     cases   checks", "-------------  ------  ---------------"];
  for (const [group, g] of Object.entries(report.groups)) {
    lines.push(`${group.padEnd(13)}  ${`${g.passed}/${g.cases}`.padEnd(6)}  ${g.checksPassed}/${g.checks} (${pct(g.checksPassed, g.checks)})`);
  }
  const t = report.totals;
  lines.push(
    "",
    `cases passed     ${t.passed}/${t.cases} (${pct(t.passed, t.cases)})`,
    `checks passed    ${t.checksPassed}/${t.checks} (${pct(t.checksPassed, t.checks)})`,
    `leak failures    ${t.leakFailures}`,
    `latency          avg ${t.avgLatencyMs.toFixed(1)} ms · p95 ${t.p95LatencyMs.toFixed(1)} ms (engine only, in-memory DB)`,
    `model calls      ${t.llmCalls} (tokens: ${t.llmCalls ? "see provider" : 0})`
  );
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const enginePath = args.includes("--engine") ? resolve(args[args.indexOf("--engine") + 1]) : resolve(import.meta.dirname, "../engine.ts");
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const engine = (await import(pathToFileURL(enginePath).href)) as { answer: AnswerFn };
  console.log(`engine: ${enginePath}\n`);
  const set = args.includes("--set") ? args[args.indexOf("--set") + 1] : "main";
  if (!CASE_SETS[set]) throw new Error(`unknown case set ${set} (main, holdout, all)`);
  let deps: Record<string, unknown> = {};
  if (args.includes("--tuning")) {
    const { readFileSync } = await import("node:fs");
    const { mergeTuning } = await import("../tuning.ts");
    deps = { tuning: mergeTuning(JSON.parse(readFileSync(args[args.indexOf("--tuning") + 1], "utf8"))) };
  }
  console.log(`cases: ${set}${deps.tuning ? ` · tuning ${(deps.tuning as { version: string }).version}` : ""}`);
  const report = await runEval(engine.answer, { verbose: !args.includes("--quiet"), cases: CASE_SETS[set], deps });
  console.log(`\n${formatReport(report)}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  if (args.includes("--strict") && (report.totals.leakFailures > 0 || report.totals.passed < report.totals.cases)) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
