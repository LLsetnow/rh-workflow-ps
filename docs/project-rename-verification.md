# 项目更名验收

2026-10-10：项目目录、包名、页面品牌、启动说明和当前路径引用统一为 `rh-workflow-ps`，本地目录为 `/Users/apple/Documents/github/rh-workflow-ps`。UXP 插件 ID 和 RPC 通道保持原身份，避免已安装插件和消息来源失效。

停止本项目服务并备份后，迁移 138 个本地数据文本文件、150 处 SQLite 文本字段，以及 15 个虚拟环境文件中的绝对路径。数据库 `PRAGMA quick_check` 通过；19 个原任务 ID 保留，全部已保存成片文件可读取，284 个原媒体文件的 SHA-256 与备份一致。服务已从新目录恢复，健康接口返回新项目名及新数据目录。

- `uv sync --locked --extra test` 和 `npm run check` 通过。
- Python 测试 36 项、宿主桥测试 11 项通过；同步脚本在临时目录重放的 12 份前端文件与本项目一致，共享 CSS 保持源文件字节。
- 浏览器 320/460/900px 的提交、工作流、成片和自检页均显示 RH Workflow PS，无横向溢出或页面错误。浏览器非 GET API 请求全部拦截，自检按钮禁用。
- Adobe UXP Developer Tools 重新登记新目录下的 `plugin/manifest.json`，状态为 Watching；Photoshop 的增效工具菜单显示 RH Workflow PS。
- Photoshop 27.11.0、UXP 9.4.1、实际 WebView 900×880：`/lab?autorun=1` 全部 15 项通过，记录时间为 `2026-10-09T18:51:17.901Z`。透明度、真实蒙版、原位置、快照复用和提示词命名均通过，临时工程关闭且不保存，合成任务已清理。

此次桌面工具只取得 Photoshop 主文档窗口，未捕获浮动 WebView 面板；更名后的页面品牌已在浏览器确认，原生页面品牌的视觉观察仍未记录。没有运行远程或付费生成。

公开提交仅包含源码、文档及测试，排除 `data/`、`artifacts/`、虚拟环境、密钥、账号、SQLite 和用户素材。实际本地凭证与待提交源码比对没有匹配。

本地报告：[原生自检](../artifacts/native-project-rename-report.json)、[浏览器检查](../artifacts/project-rename-browser-report.json)、[路径迁移](../artifacts/project-rename-migration.json)。这些报告和备份仅保留在本机。
