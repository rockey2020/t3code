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
  const state = { runs: structuredClone(runs), dispatched: 0, cancelled: [], historyRead: false };
  const api = async (path, request = {}) => {
    const root = `repos/${repository}`;
    if (path === root) return { id: options.repositoryId ?? 123 };
    if (path.startsWith(`${root}/actions/runs?`)) {
      if (options.apiError) throw new Error("GitHub unavailable");
      if (
        options.freshAfterHistory &&
        state.historyRead &&
        !state.runs.some((item) => item.id === 99)
      )
        state.runs.push(run(99, "queued", 0));
      const query = new URLSearchParams(path.split("?")[1]);
      const status = query.get("status");
      if (options.inventory) return options.inventory(status, Number(query.get("page") ?? 1));
      const selected = state.runs.filter((item) => item.status === status);
      return { total_count: options.incomplete ? 101 : selected.length, workflow_runs: selected };
    }
    if (path.startsWith(`${root}/actions/workflows/fork-maintenance.yml/runs?`)) {
      state.historyRead = true;
      if (
        options.historyPages &&
        new URLSearchParams(path.split("?")[1]).get("per_page") === "100"
      ) {
        const query = new URLSearchParams(path.split("?")[1]);
        NodeAssert.equal(query.has("created"), false);
        NodeAssert.equal(query.has("branch"), false);
        return options.historyPages[Number(query.get("page") ?? 1) - 1];
      }
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
      { ...run(1), path: ".github/workflows/fork-desktop.yml" },
      { ...run(2), head_branch: "feature" },
    ],
    { latest: run(3, "completed", 1) },
  );
  await f.execute();
  NodeAssert.deepEqual(f.state.cancelled, []);
  NodeAssert.equal(f.state.dispatched, 0);
});

for (const conclusion of ["success", "failure"]) {
  NodeTest.test(
    `later completed ${conclusion} maintenance supersedes an abandoned queue`,
    async () => {
      const f = fixture([run(1, "queued", 600), { ...run(2, "completed", 60), conclusion }]);
      for (let check = 0; check < 2; check++) {
        NodeAssert.equal((await f.execute()).status, "healthy");
      }
      NodeAssert.equal(f.state.dispatched, 0);
      NodeAssert.deepEqual(f.state.cancelled, []);
    },
  );
}

NodeTest.test(
  "a newer stale queue still needs recovery after an older queue was superseded",
  async () => {
    const f = fixture([run(1, "queued", 600), run(2, "completed", 120), run(3, "queued", 60)]);
    const result = await f.execute();
    NodeAssert.equal(result.status, "recovery-dispatched");
    NodeAssert.deepEqual(result.runs, [3]);
    NodeAssert.equal(f.state.dispatched, 1);
  },
);

NodeTest.test("older completions and other branches do not supersede a stale queue", async () => {
  const f = fixture([
    run(1, "completed", 120),
    run(2, "queued", 60),
    { ...run(3, "completed", 10), head_branch: "feature" },
  ]);
  NodeAssert.deepEqual((await f.execute()).runs, [2]);
  NodeAssert.equal(f.state.dispatched, 1);
});

NodeTest.test(
  "superseded queues use the latest observed maintenance for the seven-hour fallback",
  async () => {
    for (const [age, expected] of [
      [419, 0],
      [420, 1],
    ]) {
      const f = fixture([run(2, "completed", age), run(1, "queued", 900)]);
      const result = await f.execute();
      NodeAssert.equal(result.status, expected ? "schedule-recovered" : "healthy");
      NodeAssert.equal(f.state.dispatched, expected);
      NodeAssert.deepEqual(f.state.cancelled, []);
    }
  },
);

NodeTest.test(
  "an older-created rerun supersedes a queue when it actually started later",
  async () => {
    const rerun = {
      ...run(1, "completed", 900),
      run_started_at: new Date(now - 60 * 60_000).toISOString(),
    };
    const f = fixture([rerun, run(2, "queued", 600)]);
    NodeAssert.equal((await f.execute()).status, "healthy");
    NodeAssert.equal(f.state.dispatched, 0);
  },
);

NodeTest.test("completed reruns on later history pages supersede stale queues", async () => {
  const queue = run(2, "queued", 600);
  const rerun = {
    ...run(1, "completed", 900),
    run_started_at: new Date(now - 60 * 60_000).toISOString(),
  };
  const f = fixture([queue], {
    historyPages: [
      { total_count: 2, workflow_runs: [queue] },
      { total_count: 2, workflow_runs: [rerun] },
    ],
  });
  NodeAssert.equal((await f.execute()).status, "healthy");
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("fresh maintenance arriving during the history scan blocks dispatch", async () => {
  const f = fixture([run(1)], { freshAfterHistory: true });
  NodeAssert.equal((await f.execute()).status, "active");
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("history scanning has a fail-closed page limit", async () => {
  const f = fixture([run(1)], {
    historyPages: Array.from({ length: 10 }, (_, page) => ({
      total_count: 11,
      workflow_runs: [run(page + 20, "completed", 900)],
    })),
  });
  await NodeAssert.rejects(f.execute(), /inventory/i);
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("complete paginated inventory finds active maintenance on later pages", async () => {
  const f = fixture([run(1)], {
    inventory: (status, page) =>
      status === "queued"
        ? { total_count: 2, workflow_runs: [page === 1 ? run(1) : run(2, "queued", 0)] }
        : { total_count: 0, workflow_runs: [] },
  });
  NodeAssert.equal((await f.execute()).status, "active");
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("transient incomplete inventory requires two complete matching rescans", async () => {
  let scans = 0;
  const f = fixture([run(1)], {
    inventory: (status, page) => {
      if (status !== "queued") return { total_count: 0, workflow_runs: [] };
      if (page === 1) scans++;
      return { total_count: scans === 1 ? 2 : 1, workflow_runs: page === 1 ? [run(1)] : [] };
    },
  });
  NodeAssert.equal((await f.execute()).status, "recovery-dispatched");
  NodeAssert.ok(scans >= 3);
  NodeAssert.equal(f.state.dispatched, 1);
});

for (const [name, inventory] of [
  ["empty missing page", () => ({ total_count: 2, workflow_runs: [] })],
  ["duplicate within a page", () => ({ total_count: 2, workflow_runs: [run(1), run(1)] })],
  ["colliding pages", () => ({ total_count: 2, workflow_runs: [run(1)] })],
  ["count drift", (_, page) => ({ total_count: page === 1 ? 2 : 1, workflow_runs: [run(page)] })],
  ["missing count", () => ({ workflow_runs: [run(1)] })],
  ["invalid runs", () => ({ total_count: 0, workflow_runs: null })],
  ["page limit", (_, page) => ({ total_count: 1001, workflow_runs: [run(page)] })],
]) {
  NodeTest.test(`uncertain inventory fails closed with diagnostics: ${name}`, async () => {
    const f = fixture([run(1)], { inventory });
    await NodeAssert.rejects(
      f.execute(),
      /Incomplete Actions inventory.*status=queued.*attempt=3.*page=.*total=.*received=.*unique=/,
    );
    NodeAssert.equal(f.state.dispatched, 0);
    NodeAssert.deepEqual(f.state.cancelled, []);
  });
}

NodeTest.test("equal counts with changing run identities never authorize recovery", async () => {
  let scans = 0;
  const f = fixture([run(1)], {
    inventory: (status) => ({
      total_count: status === "queued" ? 1 : 0,
      workflow_runs: status === "queued" ? [run(++scans)] : [],
    }),
  });
  await NodeAssert.rejects(f.execute(), /changed between scans/);
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("complete stable paginated stale queues allow exactly one recovery", async () => {
  const f = fixture([run(1), run(2)], {
    inventory: (status, page) =>
      status === "queued"
        ? { total_count: 2, workflow_runs: [run(page)] }
        : { total_count: 0, workflow_runs: [] },
  });
  NodeAssert.deepEqual(await f.execute(), { status: "recovery-dispatched", runs: [1, 2] });
  NodeAssert.equal(f.state.dispatched, 1);
  NodeAssert.deepEqual(f.state.cancelled, []);
});

NodeTest.test(
  "an incomplete final status inventory blocks a previously safe candidate",
  async () => {
    let scans = 0;
    const f = fixture([run(1)], {
      inventory: (status) => {
        if (status !== "queued") return { total_count: 0, workflow_runs: [] };
        scans++;
        return scans <= 2
          ? { total_count: 1, workflow_runs: [run(1)] }
          : { total_count: 1, workflow_runs: [] };
      },
    });
    await NodeAssert.rejects(f.execute(), /Incomplete Actions inventory/);
    NodeAssert.equal(f.state.dispatched, 0);
    NodeAssert.deepEqual(f.state.cancelled, []);
  },
);

NodeTest.test("an invalid scan cannot be bridged by matching scans on either side", async () => {
  let scans = 0;
  const f = fixture([run(1)], {
    inventory: () => {
      scans++;
      return scans === 2
        ? { total_count: 1, workflow_runs: [] }
        : { total_count: 1, workflow_runs: [run(1)] };
    },
  });
  await NodeAssert.rejects(f.execute(), /Incomplete Actions inventory/);
  NodeAssert.equal(f.state.dispatched, 0);
});

NodeTest.test("equal IDs with changing statuses never authorize recovery", async () => {
  let scans = 0;
  const f = fixture([run(1)], {
    inventory: () => ({
      total_count: 1,
      workflow_runs: [run(1, ++scans % 2 ? "queued" : "in_progress")],
    }),
  });
  await NodeAssert.rejects(f.execute(), /changed between scans/);
  NodeAssert.equal(f.state.dispatched, 0);
});
