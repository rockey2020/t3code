# 简体中文维护版

这个 fork 以 `pingdotgg/t3code` 为上游，只发布 macOS ARM64 和 Windows x64 桌面安装包。GitHub Actions 每六小时检查一次上游主分支、正式版和 nightly。GitHub 的定时触发可能延迟，因此这不是严格的准点保证。

## 构建与更新

`Fork maintenance` 工作流先合并上游、检查本地化和依赖、执行变更检查，再推送。常规合并使用 Git 的三方合并；源代码冲突不会自动选取某一方或强制覆盖。冲突或验证失败会保留已发布版本，并使工作流失败，供维护任务继续修复。

正式版和 nightly 使用各自的上游 release 标签，通过三方应用加入 fork 补丁。正式版不会用当前 main 冒充。每个包在 `.fork/build.json` 和发布附件中记录上游提交、fork 提交与补丁指纹。只有两个目标都成功打包和验证后才发布。失败的任务可从 Actions 重试；`Fork maintenance` 的手动入口也可以要求重新构建。

上游其他工作流保存在 `.github/upstream-workflows`，不在本仓库触发。共享 `release-desktop.yml` 仅可被调用，包装步骤复用经验证的上游实现；定时同步将新的上游工作流归档，避免直接执行新增部署任务，维护修复时再验证更新。Windows 需要的 Linux x64 WSL 运行组件作为内部依赖构建，不发布独立 Linux 桌面包。

安装包默认不签名、不进行 Apple 公证，不需要添加签名凭据。系统可能在首次安装时显示来源/签名提示。发布目录仅包含安装包、macOS ZIP、校验和与源码记录，不发布更新 feed。T3 Code 自身的更新检查、下载、安装和更新通道切换由共享源码策略禁用，provider CLI 的维护功能不受影响。

## 依赖与翻译

依赖维护会重新发现工作区 manifest 和 catalog，覆盖上游新加入的依赖。自动尝试兼容的 patch/minor 更新，先更新锁文件，再运行检查和构建；失败则恢复该批依赖。已有补丁、显式兼容限制、耦合的框架族和 major 更新会记录在报告中，需完成迁移验证后再升级。不能把“npm 最新”当作无条件安全的替换。注册表访问失败也会单独记录。

中文补丁来源与翻译工具见 `i18n/README.md` 和 `i18n/NOTICE.md`。维护会检查导出字典和待翻译字符串。扫描器是辅助工具，不代表全部文本都已汉化。上游若出现原生中文支持，检测器暂停自动集成，维护者应优先迁移到上游框架并保留缺失翻译，而不是叠加第二套翻译系统。

## 排障

- 查看失败的 `Fork maintenance` 或 `Fork desktop release` 任务及报告附件。
- 主分支推送由正常 fast-forward 限制保护，不会 force-push 覆盖其他修改。
- `.fork/config.json` 固定仓库数字 ID，仓库被删除重建后自动任务会停止，必须重新核实目标后更新配置。
- Actions 的默认 token 已足够进行源码推送、workflow dispatch 与 release 发布；不要为了触发构建增加个人访问令牌。
- 初次启用 fork 的 Actions 或长期无提交后 GitHub 暂停定时任务，需要在 GitHub 恢复运行。工作流不会擅自修改账号或仓库安全设置。
