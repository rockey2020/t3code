# 简体中文维护版

这个 fork 以 `pingdotgg/t3code` 为上游，只发布 macOS ARM64 和 Windows x64 桌面安装包。GitHub Actions 每六小时检查一次上游主分支、正式版和 nightly。GitHub 的定时触发可能延迟，因此这不是严格的准点保证。

## 构建与更新

`Fork maintenance` 的定时和手动任务先合并上游、检查本地化和依赖、执行变更检查，再推送。主分支 push 任务验证和构建当前已合并的上游快照，不在修复提交到达时追赶新的上游提交；每六小时同步的计划不变。常规合并使用 Git 的三方合并；源代码冲突不会自动选取某一方或强制覆盖。冲突或验证失败会保留已发布版本，并使工作流失败，供维护任务继续修复。

正式版和 nightly 使用各自的上游 release 标签，通过三方应用加入 fork 补丁。正式版不会用当前 main 冒充。构建提交的应用源码来自该标签和补丁，工作流文件与主分支完全一致，不让定时任务创建或修改可执行工作流。每个包在 `.fork/build.json` 和发布附件中记录上游提交、fork 提交与补丁指纹。只有两个目标都成功打包和验证后才发布。失败的任务可从 Actions 重试；`Fork maintenance` 的手动入口也可以要求重新构建。

旧正式版的冲突修复记录在 `.fork/release-sources.json`：`sourceCommit` 是已审计的标签源码，`forkCommit` 是审计时的主分支，`fingerprint` 绑定完整补丁。上游基线未改变时，只重放后续 fork 改动。基线改变后，先三方合成仅供比较的“旧 fork 补丁 + 新上游”对照树，再计算新增 fork 改动；对照树绝不作为旧正式版源码。祖先关系不符、合成冲突或移植冲突都会停止，必须重新审计，不能把新版上游应用代码带进旧正式版。新的审计源码必须保留原标签功能，并通过类型检查、构建和回归测试，再更新记录。

上游其他工作流保存在 `.github/upstream-workflows`，不在本仓库触发。共享 `release-desktop.yml` 仅可被调用，包装步骤复用经验证的上游实现；定时同步将新的上游工作流归档，避免直接执行新增部署任务，维护修复时再验证更新。Windows 需要的 Linux x64 WSL 运行组件作为内部依赖构建，不发布独立 Linux 桌面包。

macOS 安装包内的应用使用仓库固定的自签代码证书；公开证书及 SHA256 指纹位于 `.fork/macos-signing-certificate.pem` 与 `.fork/macos-signing.json`。加密 P12 和密码仅由 Actions Secrets `FORK_MACOS_CERTIFICATE_P12`、`FORK_MACOS_CERTIFICATE_PASSWORD` 提供，每次构建导入独立临时钥匙串，完成后删除。不修改系统信任库、不安装根证书、不关闭 Gatekeeper，也不每次重新生成证书。签名或指纹校验失败会停止发布，不会回退到 ad-hoc 签名。DMG 和 ZIP 中的应用都必须通过完整签名检查，发布附件 `macos-signing.json` 绑定证书指纹与两个文件的 SHA256。固定证书到期或泄露后需要明确授权轮换。

自签证书不等于 Apple Developer ID，也不能通过 Apple 公证；Gatekeeper 仍可能阻止首次打开。固定签名用于保持该 fork 的签名身份和完整性，不保证消除首次安装提示或保留所有系统权限。自签模式不启用需要 Apple Team、provisioning profile 或 associated domains 的受限能力。Windows 包仍未签名。发布目录仅包含安装包、macOS ZIP、校验和、源码记录与签名验证记录，不发布更新 feed。T3 Code 自身的更新检查、下载、安装和更新通道切换由共享源码策略禁用，provider CLI 的维护功能不受影响。

## 依赖与翻译

依赖维护会重新发现工作区 manifest 和 catalog，覆盖上游新加入的依赖。自动尝试兼容的 patch/minor 更新，先更新锁文件，再运行检查和构建；失败则恢复该批依赖。已有补丁、显式兼容限制、耦合的框架族和 major 更新会记录在报告中，需完成迁移验证后再升级。不能把“npm 最新”当作无条件安全的替换。 严格保留原有依赖发布年龄限制，不自动添加豁免。TipTap/ProseMirror 新版已发现 Backspace 恢复列表标记的行为回归，在兼容迁移通过原回归测试前暂缓该族升级。注册表访问失败也会单独记录。

中文补丁来源与翻译工具见 `i18n/README.md` 和 `i18n/NOTICE.md`。维护会检查导出字典和待翻译字符串。扫描器是辅助工具，不代表全部文本都已汉化。上游若出现原生中文支持，检测器暂停自动集成，维护者应优先迁移到上游框架并保留缺失翻译，而不是叠加第二套翻译系统。

## 排障

- 查看失败的 `Fork maintenance` 或 `Fork desktop release` 任务及报告附件。
- 主分支推送由正常 fast-forward 限制保护，不会 force-push 覆盖其他修改。
- `.fork/config.json` 固定仓库数字 ID，仓库被删除重建后自动任务会停止，必须重新核实目标后更新配置。
- Actions 的默认 token 已足够进行源码推送、workflow dispatch 与 release 发布；不要为了触发构建增加个人访问令牌。
- 初次启用 fork 的 Actions 或长期无提交后 GitHub 暂停定时任务，需要在 GitHub 恢复运行。工作流不会擅自修改账号或仓库安全设置。
