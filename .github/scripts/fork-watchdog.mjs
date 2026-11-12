import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const workflow = "fork-maintenance.yml";
const queueLimit = 30 * 60_000;
const scheduleLimit = 7 * 60 * 60_000;

export async function recoverMaintenance({ api, config, now }) {
  const root = `repos/${config.repository}`;
  if ((await api(root)).id !== config.repositoryId)
    throw new Error("Repository identity changed; watchdog refused to act.");
  const belongs = (run) =>
    run.path === `.github/workflows/${workflow}` && run.head_branch === config.branch;
  const started = (run) => Date.parse(run.run_started_at ?? run.created_at);
  const age = (run) => now - started(run);
  const pending = async () => {
    const runs = [];
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const page = await api(`${root}/actions/runs?status=${status}&per_page=100`);
      if (page.total_count > page.workflow_runs.length)
        throw new Error("Incomplete Actions inventory; refusing recovery.");
      runs.push(...page.workflow_runs.filter(belongs));
    }
    return runs;
  };
  const runs = await pending();
  if (runs.some((run) => run.status !== "queued" || !(age(run) >= queueLimit)))
    return { status: "active", runs: runs.map((run) => run.id) };
  let candidates = [];
  for (const run of runs) {
    const current = await api(`${root}/actions/runs/${run.id}`);
    const jobs = await api(`${root}/actions/runs/${run.id}/jobs?per_page=1`);
    if (
      !belongs(current) ||
      current.status !== "queued" ||
      !(age(current) >= queueLimit) ||
      jobs.total_count !== 0
    )
      return { status: "active", runs: [run.id] };
    candidates.push(run.id);
  }
  // Cancellation has no conditional API: never race a runner starting after a read.
  // A manual dispatch shares maintenance's non-cancelling concurrency group.
  // Reruns retain their original creation time, so scan unfiltered history.
  const latest = { workflow_runs: [] };
  const seen = new Set();
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error("Actions inventory exceeds safety limit; refusing recovery.");
    const history = await api(
      `${root}/actions/workflows/${workflow}/runs?per_page=100&page=${page}`,
    );
    if (
      !Number.isInteger(history.total_count) ||
      history.total_count < 0 ||
      history.workflow_runs.some((run) => seen.has(run.id)) ||
      (!history.workflow_runs.length && seen.size < history.total_count)
    )
      throw new Error("Incomplete final Actions inventory; refusing recovery.");
    for (const run of history.workflow_runs) seen.add(run.id);
    latest.workflow_runs.push(...history.workflow_runs);
    if (seen.size >= history.total_count) break;
  }
  if (
    latest.workflow_runs.some(
      (run) =>
        belongs(run) &&
        run.status !== "completed" &&
        (run.status !== "queued" || !candidates.includes(run.id)),
    )
  )
    return { status: "active" };
  const current = await pending();
  if (
    current.some(
      (run) => run.status !== "queued" || !(age(run) >= queueLimit) || !candidates.includes(run.id),
    )
  )
    return { status: "active" };
  // Completed replacements supersede abandoned queues, even when they failed.
  // Use actual start time so reruns of older workflow records also count.
  const completed = latest.workflow_runs.filter(
    (run) => belongs(run) && run.status === "completed",
  );
  candidates = candidates.filter((id) => {
    const queued = runs.find((run) => run.id === id);
    return !completed.some((run) => started(run) > started(queued));
  });
  if (!candidates.length) {
    const recent = await api(
      `${root}/actions/workflows/${workflow}/runs?branch=${config.branch}&per_page=1`,
    );
    const previous = [...recent.workflow_runs, ...latest.workflow_runs, ...runs]
      .filter(belongs)
      .sort((left, right) => started(right) - started(left))[0];
    if (previous && !(age(previous) >= scheduleLimit)) return { status: "healthy" };
  }
  await api(`${root}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: { ref: config.branch },
  });
  return {
    status: candidates.length ? "recovery-dispatched" : "schedule-recovered",
    runs: candidates,
  };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const config = JSON.parse(
    NodeFS.readFileSync(new URL("../../.fork/config.json", import.meta.url)),
  );
  if (process.env.GITHUB_REPOSITORY !== config.repository)
    throw new Error("Watchdog is restricted to the configured fork.");
  const api = async (path, options = {}) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`);
    if (response.status === 204 || response.status === 202) return null;
    return response.json();
  };
  console.log(JSON.stringify(await recoverMaintenance({ api, config, now: Date.now() })));
}
