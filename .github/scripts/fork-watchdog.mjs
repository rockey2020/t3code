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
      let previous;
      let verified;
      let diagnostic;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const collected = [];
        const seen = new Set();
        let expected;
        let complete = false;
        for (let page = 1; page <= 10; page++) {
          const result = await api(
            `${root}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(config.branch)}&status=${status}&per_page=100&page=${page}`,
          );
          const batch = result?.workflow_runs;
          const total = result?.total_count;
          diagnostic = `status=${status} attempt=${attempt} page=${page} total=${total} received=${Array.isArray(batch) ? batch.length : "invalid"} unique=${seen.size}`;
          if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(batch)) {
            diagnostic += " invalid response";
            break;
          }
          if (batch.some((run) => !run || !belongs(run))) {
            diagnostic += " out-of-scope workflow or branch";
            break;
          }
          expected ??= total;
          if (total !== expected) {
            diagnostic += ` count changed from ${expected}`;
            break;
          }
          let collision = false;
          for (const run of batch) {
            if (!Number.isSafeInteger(run?.id) || seen.has(run.id)) {
              collision = true;
              break;
            }
            seen.add(run.id);
            collected.push(run);
          }
          diagnostic += ` collected=${seen.size}`;
          if (collision || seen.size > total) {
            diagnostic += " duplicate/invalid ID or excess runs";
            break;
          }
          if (seen.size === total) {
            complete = true;
            break;
          }
          if (!batch.length) {
            diagnostic += " empty page before total";
            break;
          }
          if (page === 10) diagnostic += " page limit exceeded";
        }
        if (!complete) {
          previous = undefined;
          continue;
        }
        // Counts alone cannot detect records moving between pages during a scan.
        const fingerprint = JSON.stringify(
          collected
            .map((run) => [
              run.id,
              run.status,
              run.path,
              run.head_branch,
              run.created_at,
              run.run_started_at,
            ])
            .sort((left, right) => left[0] - right[0]),
        );
        if (previous === fingerprint) {
          verified = collected;
          break;
        }
        diagnostic += " inventory changed between scans or not yet rechecked";
        previous = fingerprint;
      }
      if (!verified)
        throw new Error(`Incomplete Actions inventory; refusing recovery: ${diagnostic}`);
      runs.push(...verified.filter(belongs));
    }
    return runs;
  };
  const sourceState = async (run, refresh = true) => {
    if (run.status === "queued" && !(age(run) >= queueLimit))
      return { kind: "active", time: started(run) };
    const current = refresh ? await api(`${root}/actions/runs/${run.id}`) : run;
    if (!current || !belongs(current) || current.id !== run.id)
      throw new Error("Maintenance run identity changed; recovery refused.");
    if (current.status === "completed") return { kind: "completed", time: started(current) };
    let previous;
    let jobs;
    for (let attempt = 0; attempt < 3; attempt++) {
      const collected = [];
      const seen = new Set();
      let total;
      let complete = false;
      for (let page = 1; page <= 10; page++) {
        const result = await api(
          `${root}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
        );
        if (
          !Number.isSafeInteger(result?.total_count) ||
          result.total_count < 0 ||
          !Array.isArray(result.jobs)
        )
          break;
        total ??= result.total_count;
        if (
          total !== result.total_count ||
          result.jobs.some((job) => !Number.isSafeInteger(job?.id) || seen.has(job.id))
        )
          break;
        for (const job of result.jobs) {
          seen.add(job.id);
          collected.push(job);
        }
        if (seen.size !== collected.length || seen.size > total) break;
        if (seen.size === total) {
          complete = true;
          break;
        }
        if (!result.jobs.length) break;
      }
      if (!complete) {
        previous = undefined;
        continue;
      }
      const fingerprint = JSON.stringify(
        collected
          .map(({ id, name, status, conclusion, started_at, completed_at }) => [
            id,
            name,
            status,
            conclusion,
            started_at,
            completed_at,
          ])
          .sort((a, b) => a[0] - b[0]),
      );
      if (fingerprint === previous) {
        jobs = collected;
        break;
      }
      previous = fingerprint;
    }
    if (!jobs)
      throw new Error(
        `Incomplete or unstable source job inventory for run ${run.id}; refusing recovery.`,
      );
    const source = jobs.filter((job) => ["Maintain sources", "maintain"].includes(job.name));
    if (source.length === 1 && source[0].status === "completed") {
      const time = Date.parse(source[0].started_at);
      if (!Number.isFinite(time) || !source[0].conclusion)
        throw new Error(`Invalid completed source job inventory for run ${run.id}`);
      return { kind: "completed", time };
    }
    if (jobs.length === 0 && current.status === "queued" && age(current) >= queueLimit)
      return { kind: "stale", time: started(current) };
    return { kind: "active", time: started(current) };
  };
  const runs = await pending();
  const observations = new Map();
  let candidates = [];
  for (const run of runs) {
    const state = await sourceState(run);
    if (state.kind === "active") return { status: "active", runs: [run.id] };
    observations.set(run.id, state);
    if (state.kind === "stale") candidates.push(run.id);
  }
  // Never cancel a runner that can start after a read. Source-job concurrency
  // serializes recovery without holding the six-hour sync behind platform builds.
  const latest = { workflow_runs: [] };
  const seen = new Set();
  let total;
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error("Actions inventory exceeds safety limit; refusing recovery.");
    const history = await api(
      `${root}/actions/workflows/${workflow}/runs?per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(history?.total_count) ||
      history.total_count < 0 ||
      !Array.isArray(history.workflow_runs)
    )
      throw new Error("Incomplete final Actions inventory; refusing recovery.");
    total ??= history.total_count;
    if (
      total !== history.total_count ||
      history.workflow_runs.some((run) => !Number.isSafeInteger(run?.id) || seen.has(run.id))
    )
      throw new Error("Incomplete final Actions inventory; refusing recovery.");
    for (const run of history.workflow_runs) {
      seen.add(run.id);
      latest.workflow_runs.push(run);
    }
    if (
      seen.size !== latest.workflow_runs.length ||
      seen.size > total ||
      (!history.workflow_runs.length && seen.size < total)
    )
      throw new Error("Incomplete final Actions inventory; refusing recovery.");
    if (seen.size === total) break;
  }
  for (const run of latest.workflow_runs.filter(belongs)) {
    const state = await sourceState(run, false);
    if (state.kind === "active" || (state.kind === "stale" && !candidates.includes(run.id)))
      return { status: "active" };
    observations.set(run.id, state);
  }
  const current = await pending();
  for (const run of current) {
    const state = await sourceState(run);
    if (state.kind === "active" || (state.kind === "stale" && !candidates.includes(run.id)))
      return { status: "active" };
    observations.set(run.id, state);
  }
  const completed = [...observations.values()].filter((state) => state.kind === "completed");
  candidates = candidates.filter((id) => {
    const state = observations.get(id);
    return state?.kind === "stale" && !completed.some((done) => done.time > state.time);
  });
  if (!candidates.length) {
    const recent = await api(
      `${root}/actions/workflows/${workflow}/runs?branch=${config.branch}&per_page=1`,
    );
    for (const run of recent.workflow_runs.filter(belongs)) {
      const state = await sourceState(run, false);
      if (state.kind === "active" || (state.kind === "stale" && !observations.has(run.id)))
        return { status: "active" };
      observations.set(run.id, state);
    }
    const previous = Math.max(...[...observations.values()].map((state) => state.time));
    if (Number.isFinite(previous) && !(now - previous >= scheduleLimit))
      return { status: "healthy" };
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
