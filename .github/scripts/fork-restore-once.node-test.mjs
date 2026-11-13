import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { restoreMaintenanceOnce } from "./fork-restore-once.mjs";

const root = "https://api.github.com/repos/rockey2020/t3code";
const workflowUrl = `${root}/actions/workflows/414859359`;
const environment = () => ({
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY: "rockey2020/t3code",
  GITHUB_REPOSITORY_ID: "1454133935",
  GITHUB_WORKFLOW_REF: "rockey2020/t3code/.github/workflows/fork-watchdog.yml@refs/heads/main",
  GITHUB_SHA: "1111111111111111111111111111111111111111",
  GH_TOKEN: "fixture-token",
});
const push = () => ({
  before: "9b18f28b809841821e161441c3b6d2b32301c53f",
  after: "1111111111111111111111111111111111111111",
  ref: "refs/heads/main",
  forced: false,
  deleted: false,
  repository: { id: 1454133935, full_name: "rockey2020/t3code" },
});
const workflow = () => ({
  id: 414859359,
  path: ".github/workflows/fork-maintenance.yml",
  state: "disabled_manually",
  updated_at: "2026-11-13T10:52:09.000Z",
});

function fixture(options = {}) {
  const state = { calls: [], puts: 0, workflow: { ...workflow(), ...options.workflow } };
  const request = async (url, init) => {
    state.calls.push([init.method, url]);
    NodeAssert.equal(init.redirect, "error");
    NodeAssert.equal(init.headers.Authorization, "Bearer fixture-token");
    if (url === root && init.method === "GET") {
      if (options.readError) throw new Error("Network unavailable");
      return Response.json(
        options.repository ?? { id: 1454133935, full_name: "rockey2020/t3code" },
      );
    }
    if (url === workflowUrl && init.method === "GET") {
      if (state.puts && options.verifyError) throw new Error("Verification unavailable");
      return Response.json(state.workflow);
    }
    if (url === `${workflowUrl}/enable` && init.method === "PUT") {
      state.puts++;
      if (options.putOutcome instanceof Error) throw options.putOutcome;
      state.workflow = options.afterPut ?? { ...state.workflow, state: "active" };
      return new Response(null, { status: options.putOutcome ?? 204 });
    }
    throw new Error(`Unexpected request ${init.method} ${url}`);
  };
  return {
    state,
    execute: (env = environment(), event = push()) =>
      restoreMaintenanceOnce({ env, event, request }),
  };
}

NodeTest.test(
  "restores only the pinned disabled event once and verifies active state",
  async () => {
    const f = fixture();
    NodeAssert.deepEqual(await f.execute(), { status: "enabled" });
    NodeAssert.equal(f.state.workflow.state, "active");
    NodeAssert.deepEqual(f.state.calls, [
      ["GET", root],
      ["GET", workflowUrl],
      ["PUT", `${workflowUrl}/enable`],
      ["GET", workflowUrl],
    ]);
  },
);

NodeTest.test("other events, branches, runs and repositories cannot reach the API", async () => {
  for (const patch of [
    { GITHUB_EVENT_NAME: "schedule" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_RUN_ATTEMPT: undefined },
    { GITHUB_REPOSITORY: "other/t3code" },
    { GITHUB_REPOSITORY_ID: "1" },
    { GITHUB_WORKFLOW_REF: "rockey2020/t3code/.github/workflows/other.yml@refs/heads/main" },
    { GITHUB_SHA: "" },
  ]) {
    const f = fixture();
    NodeAssert.equal((await f.execute({ ...environment(), ...patch })).status, "skipped");
    NodeAssert.deepEqual(f.state.calls, [], JSON.stringify(patch));
  }
});

NodeTest.test(
  "later pushes, force pushes and mismatched payloads cannot reach the API",
  async () => {
    for (const patch of [
      { before: "2222222222222222222222222222222222222222" },
      { after: "2222222222222222222222222222222222222222" },
      { ref: "refs/heads/other" },
      { forced: true },
      { deleted: true },
      { forced: undefined },
      { repository: { id: 1, full_name: "rockey2020/t3code" } },
      { repository: { id: 1454133935, full_name: "other/t3code" } },
    ]) {
      const f = fixture();
      NodeAssert.equal((await f.execute(environment(), { ...push(), ...patch })).status, "skipped");
      NodeAssert.deepEqual(f.state.calls, [], JSON.stringify(patch));
    }
    const f = fixture();
    NodeAssert.equal((await f.execute(environment(), null)).status, "skipped");
    NodeAssert.deepEqual(f.state.calls, []);
  },
);

NodeTest.test("changed identity, later disable or unknown state prevents enabling", async () => {
  for (const options of [
    { repository: { id: 1, full_name: "rockey2020/t3code" } },
    { repository: { id: 1454133935, full_name: "other/t3code" } },
    { workflow: { id: 1 } },
    { workflow: { path: ".github/workflows/other.yml" } },
    { workflow: { updated_at: "2026-11-13T15:00:00.000Z" } },
    { workflow: { updated_at: null } },
    { workflow: { state: "disabled_inactivity" } },
    { workflow: { state: null } },
    { readError: true },
  ]) {
    const f = fixture(options);
    await NodeAssert.rejects(f.execute());
    NodeAssert.equal(f.state.puts, 0, JSON.stringify(options));
  }
});

NodeTest.test("an already active workflow is left alone", async () => {
  const f = fixture({ workflow: { state: "active", updated_at: "2026-11-13T15:00:00.000Z" } });
  NodeAssert.deepEqual(await f.execute(), { status: "already-active" });
  NodeAssert.equal(f.state.puts, 0);
});

NodeTest.test("missing runtime token fails before any request", async () => {
  const f = fixture();
  await NodeAssert.rejects(f.execute({ ...environment(), GH_TOKEN: undefined }));
  NodeAssert.deepEqual(f.state.calls, []);
});

NodeTest.test("uncertain or rejected enable responses never retry or claim success", async () => {
  for (const putOutcome of [
    new Error("Connection reset: fixture-token"),
    200,
    202,
    302,
    403,
    429,
    500,
  ]) {
    const f = fixture({ putOutcome });
    await NodeAssert.rejects(f.execute(), (error) => {
      NodeAssert.match(error.message, /not retried/i);
      NodeAssert.match(
        error.message,
        putOutcome instanceof Error ? /network/i : new RegExp(`HTTP ${putOutcome}`),
      );
      NodeAssert.doesNotMatch(error.message, /fixture-token/);
      return true;
    });
    NodeAssert.equal(f.state.puts, 1);
    NodeAssert.equal(f.state.calls.length, 3);
    NodeAssert.equal(
      (await f.execute({ ...environment(), GITHUB_RUN_ATTEMPT: "2" })).status,
      "skipped",
    );
    NodeAssert.equal(
      (await f.execute(environment(), { ...push(), before: environment().GITHUB_SHA })).status,
      "skipped",
    );
    NodeAssert.equal(f.state.calls.length, 3);
  }
});

NodeTest.test(
  "failed verification or a later disable after PUT never triggers a second enable",
  async () => {
    for (const options of [
      { verifyError: true },
      { afterPut: { ...workflow(), updated_at: "2026-11-13T15:01:00.000Z" } },
      { afterPut: { ...workflow(), state: "active", id: 1 } },
    ]) {
      const f = fixture(options);
      await NodeAssert.rejects(f.execute());
      NodeAssert.equal(f.state.puts, 1);
      NodeAssert.equal(f.state.calls.length, 4);
    }
  },
);
