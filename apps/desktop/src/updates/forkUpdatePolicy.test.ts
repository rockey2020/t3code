import { assert, it } from "@effect/vitest";
import { APP_UPDATES_DISABLED_REASON } from "@t3tools/shared/appUpdatePolicy";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { resolveUpdatePolicy } from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect(
  "never checks, downloads, or installs app updates, including after a track change",
  () => {
    const harness = makeHarness({
      env: { T3CODE_DISABLE_AUTO_UPDATE: "false" },
      policy: resolveUpdatePolicy({
        schemaVersion: 1,
        organization: "Test",
        limits: { updates: { mode: "auto", allowNightly: true } },
      }),
    });
    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust("1 day");
      assert.isFalse((yield* updates.check("manual")).checked);
      const channelError = yield* updates.setChannel("nightly").pipe(Effect.flip);
      assert.equal(channelError._tag, "DesktopUpdateChannelManagedError");
      yield* updates.setChannel("latest");
      assert.isFalse((yield* updates.download).accepted);
      assert.isFalse((yield* updates.install).accepted);
      const state = yield* updates.getState;
      assert.equal(state.status, "disabled");
      assert.equal(state.message, APP_UPDATES_DISABLED_REASON);
      assert.equal(harness.checkCount(), 0);
      assert.equal(harness.downloadCount(), 0);
      assert.equal(harness.quitAndInstalls(), 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  },
);
