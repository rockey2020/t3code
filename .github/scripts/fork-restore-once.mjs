import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Temporary recovery for this disable only. Remove after the restoration push is verified.
export async function restoreMaintenanceOnce({ env, event, request = fetch }) {
  const repository = "rockey2020/t3code";
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_REPOSITORY_ID !== "1454133935" ||
    env.GITHUB_WORKFLOW_REF !==
      `${repository}/.github/workflows/fork-watchdog.yml@refs/heads/main` ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    event?.before !== "9b18f28b809841821e161441c3b6d2b32301c53f" ||
    event.after !== env.GITHUB_SHA ||
    event.ref !== "refs/heads/main" ||
    event.forced !== false ||
    event.deleted !== false ||
    event.repository?.id !== 1454133935 ||
    event.repository.full_name !== repository
  )
    return { status: "skipped" };
  if (!env.GH_TOKEN) throw new Error("Missing Actions runtime token; restoration refused.");
  const root = `https://api.github.com/repos/${repository}`;
  const workflowUrl = `${root}/actions/workflows/414859359`;
  const api = async (url, method = "GET") => {
    const response = await request(url, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== (method === "PUT" ? 204 : 200))
      throw Object.assign(new Error(`Unexpected GitHub ${method} status ${response.status}.`), {
        status: response.status,
      });
    return method === "GET" ? response.json() : null;
  };
  const repo = await api(root);
  if (repo?.id !== 1454133935 || repo.full_name !== repository)
    throw new Error("Repository identity changed; restoration refused.");
  const readWorkflow = async () => {
    const current = await api(workflowUrl);
    if (current?.id !== 414859359 || current.path !== ".github/workflows/fork-maintenance.yml")
      throw new Error("Workflow identity changed; restoration refused.");
    return current;
  };
  const current = await readWorkflow();
  if (current.state === "active") return { status: "already-active" };
  if (current.state !== "disabled_manually" || current.updated_at !== "2026-11-13T10:52:09.000Z")
    throw new Error("Disabled event changed; restoration refused.");
  try {
    await api(`${workflowUrl}/enable`, "PUT");
  } catch (error) {
    const reason = Number.isInteger(error?.status)
      ? `GitHub HTTP ${error.status}`
      : "Network response unavailable";
    // oxlint-disable-next-line preserve-caught-error -- Raw network errors may expose credentials.
    throw new Error(
      `${reason}: enable result is unconfirmed and was not retried. Inspect workflow state before any further action.`,
    );
  }
  if ((await readWorkflow()).state !== "active")
    throw new Error("Active state was not verified; no further enable will be attempted.");
  return { status: "enabled" };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
    : null;
  console.log(JSON.stringify(await restoreMaintenanceOnce({ env: process.env, event })));
}
