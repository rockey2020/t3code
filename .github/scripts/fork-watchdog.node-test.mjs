import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { recoverMaintenance } from "./fork-watchdog.mjs";

const now = Date.parse("2026-11-12T06:00:00Z");
const repository = "fixture/fork";
const run = (id, status = "queued", age = 60) => ({
  id,
  path: ".github/workflows/fork-maintenance.yml",
  head_branch: "main",
  status,
  created_at: new Date(now - age * 60_000).toISOString(),
  run_started_at: new Date(now - age * 60_000).toISOString(),
});

function fixture(runs, options = {}) {
  const state = { runs: structuredClone(runs), dispatched: 0, cancelled: [] };
  const api = async (path, request = {}) => {
    const root = `repos/${repository}`;
    if (path === root) return { id: options.repositoryId ?? 123 };
    if (path.startsWith(`${root}/actions/runs?`)) {
      if (options.apiError) throw new Error("GitHub unavailable");
      const status = new URLSearchParams(path.split("?")[1]).get("status");
      const selected = state.runs.filter((item) => item.status === status);
      return { total_count: options.incomplete ? 101 : selected.length, workflow_runs: selected };
    }
    if (path.startsWith(`${root}/actions/workflows/fork-maintenance.yml/runs?`)) {
      const selected = options.freshAtRecheck
        ? [run(9, "queued", 0)]
        : options.latest
          ? [options.latest]
          : [...state.runs].reverse();
      return {
        total_count: options.incompleteFinal ? 101 : selected.length,
        workflow_runs: selected,
      };
    }
    if (path.endsWith("/dispatches")) {
      NodeAssert.deepEqual(request.body, { ref: "main" });
      state.dispatched++;
      return null;
    }
    const match = path.match(/\/actions\/runs\/(\d+)(.*)$/);
    if (!match) throw new Error(`Unexpected API path ${path}`);
    const current = state.runs.find((item) => item.id === Number(match[1]));
    if (match[2].startsWith("/jobs")) return { total_count: options.jobs ?? 0, jobs: [] };
    if (match[2] === "/cancel") {
      state.cancelled.push(current.id);
      throw new Error("Cancellation must never be requested");
    }
    if (options.startedDuringCheck) current.status = "in_progress";
    return { ...current };
  };
  return {
    state,
    execute: () =>
      recoverMaintenance({
        api,
        config: { repository, repositoryId: 123, branch: "main" },
        now,
      }),
  };
}

NodeTest.test(
  "dispatches current main once for empty stale queues without cancellation",
  async () => {
    const f = fixture([run(1), run(2, "queued", 90)]);
    NodeAssert.equal((await f.execute()).status, "recovery-dispatched");
    NodeAssert.deepEqual(f.state.cancelled, []);
    NodeAssert.equal(f.state.dispatched, 1);
  },
);

for (const options of [{ incomplete: true }, { incompleteFinal: true }, { apiError: true }]) {
  NodeTest.test(
    `fails closed on incomplete or unavailable inventory ${JSON.stringify(options)}`,
    async () => {
      const f = fixture([run(1)], options);
      await NodeAssert.rejects(f.execute());
      NodeAssert.deepEqual(f.state.cancelled, []);
      NodeAssert.equal(f.state.dispatched, 0);
    },
  );
}

for (const [name, runs, options] of [
  ["running maintenance", [run(1), run(2, "in_progress")], {}],
  ["fresh queued maintenance", [run(1), run(2, "queued", 10)], {}],
  ["waiting for approval", [run(1), run(2, "waiting")], {}],
  ["queue with jobs", [run(1)], { jobs: 1 }],
  ["started during recheck", [run(1)], { startedDuringCheck: true }],
]) {
  NodeTest.test(`does not interrupt ${name}`, async () => {
    const f = fixture(runs, options);
    await f.execute();
    NodeAssert.deepEqual(f.state.cancelled, []);
    NodeAssert.equal(f.state.dispatched, 0);
  });
}

NodeTest.test("fresh maintenance at the final recheck prevents recovery dispatch", async () => {
  const f = fixture([run(1)], { freshAtRecheck: true });
  await f.execute();
  NodeAssert.deepEqual(f.state.cancelled, []);
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("repository identity mismatch prevents all mutations", async () => {
  const f = fixture([run(1)], { repositoryId: 999 });
  await NodeAssert.rejects(f.execute(), /identity/i);
  NodeAssert.deepEqual(f.state.cancelled, []);
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("missed schedules recover only after seven hours without maintenance", async () => {
  for (const [age, expected] of [
    [60, 0],
    [420, 1],
  ]) {
    const f = fixture([], { latest: run(1, "completed", age) });
    await f.execute();
    NodeAssert.equal(f.state.dispatched, expected);
  }
});

NodeTest.test("does not cancel another workflow or branch", async () => {
  const f = fixture(
    [
      { ...run(1), path: ".github/workflows/fork-build.yml" },
      { ...run(2), head_branch: "feature" },
    ],
    { latest: run(3, "completed", 1) },
  );
  await f.execute();
  NodeAssert.deepEqual(f.state.cancelled, []);
  NodeAssert.equal(f.state.dispatched, 0);
});
