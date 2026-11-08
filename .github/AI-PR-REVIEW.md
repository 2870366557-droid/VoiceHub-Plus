# AI 自动审查 PR

本仓库配置了 PR 自动代码审查：每次 PR 有新的改动时，由大模型阅读 diff 并在 PR 下发布一条分级审查意见。

- 工作流文件：[`.github/workflows/ai-pr-review.yml`](workflows/ai-pr-review.yml)
- 审查模型：GitHub Models（默认 `openai/gpt-4o-mini`）
- 凭据：**不需要任何 API Key、不需要配置 Secret**

## 一、为什么不需要密钥

工作流使用 GitHub Actions 自带的 `GITHUB_TOKEN`，并在 `permissions` 中声明 `models: read`，即可调用 GitHub 官方的模型推理服务 `https://models.github.ai/inference/chat/completions`。该能力对所有 GitHub 账号开放，按账号计算免费额度。

因此本配置：

- 不新增任何 Secret、不引入第三方 App、不需要 OAuth 授权；
- 不读取或回显任何环境变量之外的凭据；
- 代码、日志、PR 评论里都不会出现密钥。

## 二、触发时机

| 触发方式 | 说明 |
| --- | --- |
| PR 新建 / 重新打开 | 自动审查 |
| PR 推送新提交 | 自动重新审查，并**更新同一条评论**（不会刷屏） |
| 草稿转正式 | 自动审查（草稿状态跳过） |
| 手动触发 | Actions → `AI PR Review` → `Run workflow`，填写 PR 编号 |

自动触发使用 `pull_request_target`，这样来自 fork 分支和自动化依赖更新的 PR 也能正常写评论。安全性见下一节。

## 三、安全设计

| 措施 | 说明 |
| --- | --- |
| 不执行 PR 代码 | 工作流**不 checkout、不安装依赖、不运行任何来自 PR 的脚本**，只通过 API 读取 diff 纯文本。工作流脚本本身来自默认分支，不受 PR 内容影响 |
| 最小权限 | 仅 `contents: read`、`pull-requests: write`、`issues: write`、`models: read`，无写源码、无 Secrets 读取权限 |
| 防提示注入 | 系统提示明确把 PR 标题与 diff 定性为「待审查数据」，要求模型忽略其中改变角色、索取凭据、执行命令、外链跳转等指令 |
| 输出受限 | 模型输出截断到 6000 字符，评论里只写审查意见与日志链接 |
| 失败不阻塞 | 模型超时、限流或返回异常时只记录 warning 并正常结束，**不会让 PR 的检查项变红** |
| 幂等 | 用隐藏标记识别既有评论并原地更新；同一 PR 的并发运行由 `concurrency` 组自动取消旧任务 |

> 说明：AI 审查只是辅助，不替代人工评审，也不作为合并的强制门禁。

## 四、可调配置

常规调整**不需要改代码**，在仓库 `Settings → Secrets and variables → Actions → Variables` 新增仓库变量即可：

| 变量名 | 作用 | 默认值 |
| --- | --- | --- |
| `AI_REVIEW_MODEL` | 更换审查模型（GitHub Models 中的模型 ID） | `openai/gpt-4o-mini` |

需要改行为时，编辑工作流 `script` 顶部的常量：

| 常量 | 作用 | 默认值 |
| --- | --- | --- |
| `MAX_FILES` | 单次最多送审文件数 | `30` |
| `MAX_PATCH_CHARS` | 送审 diff 总字符上限 | `16000` |
| `SKIP` | 跳过的文件（锁文件、压缩资源、二进制等） | 见文件 |
| `SYSTEM` | 审查规则与输出格式 | 见文件 |

建议换用推理能力更强的模型时，同步下调 `MAX_PATCH_CHARS`，避免超出上下文。

## 五、额度与已知限制

- 免费额度按**账号**计算（不是按仓库或按 token），低档模型约 150 次/天、每分钟十余次，单次请求约 8K 输入 / 4K 输出 token。超出时接口返回 429，工作流只记 warning，不影响 PR。
- 大模型看不到未改动的上下文文件，只能依据 diff 判断，可能漏掉跨文件的隐含问题。
- 超大 PR 会按上限截断，评论底部会标注实际送审文件数。
- 生成结果可能有误报，请人工复核后再决定是否修改代码。
- 若需要更高额度或更长上下文，可在账号 `Settings → Models` 开启按量付费，或改为自带模型密钥（届时需自行新增 Secret，本配置默认不启用）。

## 六、验证与排障

手动触发一次即可验证整条链路：Actions → `AI PR Review` → `Run workflow` → 填入任一开放 PR 的编号。成功时该 PR 下会出现一条以「AI 代码审查」开头的评论，日志里能看到 `已发布审查评论` 或 `已更新既有审查评论`。

| 现象 | 排查方向 |
| --- | --- |
| 评论没出现 | 看工作流日志：是否 `没有可审查的文本改动`（只改了锁文件/图片）、是否 warning 提示模型调用失败 |
| `Models HTTP 403` | 确认 `permissions` 中保留了 `models: read`；PR 触发事件是否为 `pull_request_target` |
| `Models HTTP 429` | 免费额度用尽，等待重置或调低审查频率、换更低档模型 |
| 想临时停用 | 在 Actions 页面禁用该工作流，或直接删除本工作流文件 |
| 想彻底移除 | 删除 `.github/workflows/ai-pr-review.yml` 与本文档，并手动删除历史审查评论 |
