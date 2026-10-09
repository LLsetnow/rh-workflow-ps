# 工作流收藏模型选择

`Load LoRA · lora_name` 和 `Load Diffusion Model · unet_name` 自动提供收藏模型下拉框。工作流库和临时快照的输入配置也可选择默认模型。已有手动配置只显示其中选定的字段。

模型列表优先使用工作流绑定账号，否则使用当前账号；优先选择同一账号的个人 Key，没有 Key 时不会借用其他账号。PS 使用自己的 `data/` 和 8768 服务，前端通过 `scripts/sync-desk-ui.py` 同步 Desk 的共用控件，账号、Key 和数据库保持独立。

列表有效期为 5 分钟，点击「刷新」重新读取收藏。工作流原值不在收藏中时仍作为当前值保留；「手动」可填写完整模型名称，「列表」切回下拉框。收藏为空或读取失败时仍保留当前值，可以手动填写或重试。选择值进入草稿、库内默认值、任务快照、历史回放及工作流导出。

LoRA 下拉选项显示 `[qwen-image-2.1] COS.safetensors` 形式的适配基础模型标签；扩散模型选项显示 `[Qwen-Edit-2509] qwnImageEdit_v16Bf16.safetensors` 形式的模型种类标签。完整选中标签也显示在悬停标题中。两类标签都来自 RunningHub 模型版本的 `baseModel`；下拉选项值、草稿和导出仍是原始文件名。未公开、标签缺失、同名版本标签冲突或查询失败时，LoRA 显示 `[适配模型未知]`，扩散模型显示 `[模型种类未知]`，选择功能仍可用。

两类收藏选项都先按标签名称 A–Z 排序，再按模型文件名 A–Z 排序，忽略大小写；未知标签排在最后，并按文件名排序。当前选择值保持不变，收藏之外的当前值仍单独保留。任务提交页、默认值配置、刷新和手动切回列表使用同一顺序。新标签数据需要后台加载新版代码，前端控件在重新加载面板后应用；重启服务须先确认没有活动或排队任务。

本地接口为 `GET /api/models/favorites`，可选 `account_id` 与 `refresh=1`。返回 `models.lora`、`models.diffusion` 文件名数组，`model_metadata.lora[原始文件名].base_model` 与 `model_metadata.diffusion[原始文件名].base_model` 标签，以及 `account_id`、`site`、`source` 和 `cached`。后端提取 RunningHub 完整 `object_info` 中的 `LoraLoader` / `UNETLoader` 选项，然后使用同一账号、同一站点的 [公共模型列表 API](https://www.runninghub.cn/runninghub-api-doc-cn/api-437269263) 查询标签，`resourceType` 分别为 `LORA` 与 `UNET`。

标签仅关联同类型且 `versions[].versionResourceName` 精确匹配的文件，不从文件名猜测标签；按类型规范化标准 `models/loras/`、`models/unet/`、`models/diffusion_models/` 前缀，统一路径分隔符，保留子目录与大小写区别。搜索结果不会新增收藏选项；搜索未读完或标签有冲突时保持未知。每类最多查询 64 个模型，每个最多 3 页，交错查询两类名称，共用 4 个并发和 12 秒预算。文件名与标签按账号、站点和 Key 指纹共同缓存，并合并并发读取；刷新同时更新标签。凭证和代理 URL 不进入前端或错误响应，读取列表不会创建生成任务。

## 验证（2026-10-10）

- `npm run check` 通过；Python 全量 66 项、原生桥 11 项通过。
- 浏览器合成工作流在 320、460、900、1260px 检查 LoRA 适配标签、扩散模型种类标签、未知标签、下拉选择、原值保留、导出、草稿恢复、手动输入、空列表、失败重试及默认模型配置；控件及按钮均在面板可视宽度内。
- 模拟账号切换的延迟响应没有覆盖新账号列表；模型测试覆盖缓存、并发和错误脱敏。
- 使用本项目配置进行只读查询，9 个收藏 LoRA 均取得标签，8 个扩散模型中 7 个取得标签，标签查询耗时约 5.7 秒；`COS.safetensors` 对应 `qwen-image-2.1`，`qwnImageEdit_v16Bf16.safetensors` 对应 `Qwen-Edit-2509`。`qwen_image_2.1_bf16.safetensors` 的同名公开版本分别标为 `Qwen-image` 与 `Other`，保留未知；未提交 RunningHub/Codex 付费任务。
- 依用户要求，实际 Photoshop WebView 下拉框及 `/lab?autorun=1` 复验留到当前编辑结束后进行。上一轮界面自动化多次因文档或窗口状态变化被拦截，既有原生自检记录没有作为模型下拉框的面板验收结果。
- 两类选项使用乱序、多种标签、大小写混合和未知标签检查排序，刷新、手动切回列表及默认值配置顺序一致，选中值与导出保持不变；后端用例覆盖同名 LoRA/UNET 的类型隔离、准确版本关联、冲突标签、查询预算、缓存及查询失败降级。
