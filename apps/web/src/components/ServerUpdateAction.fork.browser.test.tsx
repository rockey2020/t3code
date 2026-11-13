import { RegistryContext } from "@effect/atom-react";
import type { AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  sessionAtom: null as unknown,
}));

vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => testState.sessionAtom) as never,
    },
  };
});

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map([["fork-update-test", { environment: { serverVersion: "0.0.30" } }]])) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ServerUpdateAction,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

it("blocks single and batch updates even when the session grants maintenance access", async () => {
  testState.updateServer
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" }));
  testState.sessionAtom = Atom.make(
    AsyncResult.success({
      authenticated: true,
      scopes: ["environment:maintain"],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "t3_session",
        serverUpdateScope: "environment:maintain",
      },
    } satisfies AuthSessionState),
  );
  const target = {
    environmentId: "fork-update-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.31",
  } satisfies ServerUpdateTarget;

  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ServerUpdateAction {...target} />
      <ServerUpdatesAction targets={[target]} />
    </RegistryContext.Provider>,
  );

  await expect.element(screen.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
  await screen.getByRole("button", { name: "Update all", exact: true }).click();
  expect(testState.updateServer).not.toHaveBeenCalled();
});
