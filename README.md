# RH Workflow PS

RH Workflow PS 把 RH Workflow Desk 的网页界面嵌入 Photoshop 的 WebView；UXP 承担图层、选区、文件选择和图像回贴。业务界面使用浏览器的 HTML/CSS/JS。

源码仓库：[LLsetnow/rh-workflow-ps](https://github.com/LLsetnow/rh-workflow-ps)。

目录：`/Users/apple/Documents/github/rh-workflow-ps`。项目独立于 `rh-workflow-desk`，使用自己的数据目录和 8768 端口。

## 启动

```sh
cd /Users/apple/Documents/github/rh-workflow-ps
uv sync --extra test
./scripts/start-server.sh --no-browser
```

1. 在 Adobe UXP Developer Tools 中添加此项目的 `plugin/manifest.json`，点击 Load。
2. 在 Photoshop 的「增效工具 → RH Workflow PS → RH Workflow PS」打开面板。
3. 新项目的本地服务是 `http://localhost:8768`；可以先在浏览器预览。

UXP 插件 ID 保持 `com.llsetnow.rhworkflowpswebview`，以继续使用现有的插件身份及消息来源校验；项目和面板名称均为 RH Workflow PS。

面板在服务未启动时提供启动按钮，也可以双击 `plugin/start-server.command`。数据只写入本项目的 `data/`。API Key、账号和模型需要在新项目中自行配置；不会复制原项目的凭证、数据库或用户素材。

## 已接入的界面与 Photoshop 操作

- 工作流库、任务提交、成片库、仪表盘、设置，以及 Codex 图像、深度/骨骼、角色语音界面，来自 Desk 前端。
- 工作流中的 `lora_name` 与 `unet_name` 使用收藏模型下拉框，支持刷新及手动输入；工作流库可选择默认模型，草稿、历史和导出保留选择值。模型列表只使用本项目配置的账号与 Key，见 [模型选择](docs/model-selection.md)。
- 普通图片默认读取工程图层：有选区时读取活动图层的选区矩形，无选区时读取图层自身完整边界。取消“图片来源”下拉框，本地参考图通过独立按钮切换。输入绑定随工作流草稿和保存内容保留。
- 可以新增、删除 LoadImage / LoadImageMask。蒙版节点固定使用活动图层选区，保留羽化和抗锯齿灰度；未连接节点和删除后断开的必填连接会阻止提交。
- 预览与提交在工程状态一致时复用同一图片快照；图层或选区变化后自动刷新。
- 最终图片默认自动加入提交时的原工程，每张成片直接建立以提示词命名的顶层图层，不创建组。有选区时恢复原矩形与真实图层蒙版；无选区时保持输出原尺寸，对齐输入图层或居中。
- 成片右键「导入项目」列出所有打开的 Photoshop 工程。卡片拖出面板调用同一导入桥，保留成片的位置和蒙版；已观察到实际画布拖放创建图层。
- 「自动归类」把 A.psd 提交的任务放入 A 项目，显式选择项目优先。单行下拉框统一 40px，工作流删除使用 HTML 确认窗口，捕获提示复用 Desk toast。
- 提示词工坊、专注模式页面已移除。Telegram 入站界面已隐藏，接收线程已禁用，设置接口拒绝启用入站；Telegram 成片推送保留。

Electron 的账号登录窗口、自动签到尚未迁移；深度/骨骼、语音的模型环境未打包。原工程关闭、PS 会话变化、画布尺寸变化或蒙版附件缺失时保留成片，在导入界面说明原因。重复完成通知不会重复建层；明确的新手动导入可以再建一层。

每张图片的稳定身份、位置和选区蒙版保存在该任务目录的 `.photoshop/<output_id>/`。改名或项目归类不会改变附件关联；复制到项目外时须连同整个任务目录及记录一起保留，仅复制 PNG 不能携带 Photoshop 图层蒙版。

## 用真实 Photoshop 验收

面板顶部「Photoshop → 开发自检」，或「增效工具 → RH Workflow PS → WebView 本地自检」，打开 `/lab`。

自检在一个 300×200 合成临时文档中检查：图层自身边界、零输入居中、返回尺寸变化、重复通知、选区图像、蒙版灰度、选区取消后的恢复，以及手动请求幂等。测试结束后关闭临时文档且不保存、恢复原文档，并清理合成任务；不会提交 RunningHub/Codex 任务。结果保存在 `data/webview-diagnostics.json`。

本轮实测：Photoshop 27.11.0、UXP 9.4.1，WebView 1318×1362；全部 15 项原生步骤通过，包括快照复用、提示词命名的顶层图层、8/16/32 位透明度、377×611 灰度蒙版及原位置恢复。临时文档和合成任务均已清理。

浏览器已检查 320/460/900px 布局及删除、导入和拖动事件模拟；真实 Photoshop 浮动面板已观察普通图片、固定选区蒙版及成片页面，并检测到 5 次实际拖放导入。用户确认已编辑现有蒙版，因此这些图层的后续像素不作为导入算法的原始测试样本。窄面板、删除确认框和 toast 的原生视觉尚未逐项复验。最新范围见 [图片工作流验收记录](docs/photoshop-image-workflow-verification.md)，旧版自检记录保留在 `docs/verification.json`。

「WebView 拖放验收」提供独立的合成工程和成片卡片，拖入后点击「校验并关闭临时工程」，或「取消并清理」。这条开发检查同样不会调用生成服务。

UXP 的消息事件把**完整页面 URL**放入 `event.origin`，包括路径及查询参数。本项目按允许的本地域名校验，并保留完整 URL 回复；不能照搬浏览器中只比较 origin 的代码。

## 避免再次把网页样式写进 UXP

`static/app.css` 是 Desk 原始共享样式，保留源文件字节。`static/ps-webview.css` 只增加窄面板布局和 Photoshop 控件；`static/ps-webview.js` 只负责宿主桥接。原生 `plugin/shell.css` 只布局 WebView 和服务启动提示。

```sh
# 同步 Desk 前端，重复应用少量宿主钩子。
python3 scripts/sync-desk-ui.py
npm run check
npm run test:bridge
npm test
```

同步脚本不复制提示词工坊和专注模式资源，会记录源版本及文件 SHA-256 到 `docs/source-ui.json`。如果 Desk 的提交函数发生变化，脚本会明确报错，要求更新钩子。

每次修改先检查浏览器 320/460/900px 布局，再检查 Photoshop 内相同页面；涉及原生能力时运行 `/lab`。浏览器预览、HTTP 测试、原生自检和付费云端任务是不同的验收范围。

Adobe 官方参考：[WebView、消息桥及权限](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/html-elements/html-web-view-element)、[Photoshop WebView 界面方案](https://blog.developer.adobe.com/en/publish/2026/03/introducing-webview-ui-in-bolt-uxp-build-richer-adobe-plugins-faster)。
