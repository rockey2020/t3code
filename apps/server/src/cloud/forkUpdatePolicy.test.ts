import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { APP_UPDATES_DISABLED_REASON } from "@t3tools/shared/appUpdatePolicy";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";

import { managedUpdateRefusal } from "../policy/managedUpdates.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";
import { resolveServerSelfUpdateCapability } from "./selfUpdate.ts";

it("refuses CLI and server updates regardless of administrator policy", () => {
  expect(managedUpdateRefusal(undefined)).toBe(APP_UPDATES_DISABLED_REASON);
  expect(
    managedUpdateRefusal(
      {
        schemaVersion: 1,
        organization: "Test",
        limits: { updates: { mode: "auto", allowNightly: true } },
      },
      "nightly",
    ),
  ).toBe(APP_UPDATES_DISABLED_REASON);
  expect(
    resolveServerSelfUpdateCapability({ desktopManaged: true, launcherManaged: true }),
  ).toBeNull();
  expect(
    resolveServerSelfUpdateCapability({ desktopManaged: false, launcherManaged: true }),
  ).toBeNull();
});

it.effect("returns no app releases without network or subprocess activity", () =>
  Effect.gen(function* () {
    const releases = yield* NpmRelease.make();
    expect(yield* releases.get({ spec: "latest" })).toBeNull();
    expect(yield* releases.get({ spec: "nightly" })).toBeNull();
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () => Effect.die("App update lookup must not start npm"),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("App update lookup must not contact a registry")),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
