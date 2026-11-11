import { expect, it } from "vite-plus/test";

import { translateMaintenanceLabel } from "./settingsMaintenance.messages";

it("maps server worktree blockers without changing terminal actions or English errors", () => {
  expect(translateMaintenanceLabel("Open terminal", "zh-CN")).toBe("有打开的终端");
  expect(translateMaintenanceLabel("open terminal", "zh-CN")).toBe("有打开的终端");
  expect(
    translateMaintenanceLabel(
      "Error invoking remote method 'desktop:cleanup': Error: Open terminal",
      "zh-CN",
    ),
  ).toBe("有打开的终端");
  expect(translateMaintenanceLabel("Open terminal", "en")).toBe("Open terminal");
});

it.each([
  ["Every connected machine is already on Stable.", "所有已连接机器均已使用 稳定版。"],
  [
    "Every connected machine is already on Stable. This only saves the track.",
    "所有已连接机器都已使用 稳定版。这只会保存更新通道。",
  ],
  ["No machine can switch to Nightly now.", "目前没有机器可以切换到 Nightly 版。"],
  [
    "No machine can switch to Nightly now. This only saves the track.",
    "目前没有机器可以切换到 Nightly 版。此操作仅保存更新渠道。",
  ],
])("translates track-switch idle reasons and nested channels: %s", (source, expected) => {
  expect(translateMaintenanceLabel(source, "zh-CN")).toBe(expected);
  expect(translateMaintenanceLabel(source, "en")).toBe(source);
});
