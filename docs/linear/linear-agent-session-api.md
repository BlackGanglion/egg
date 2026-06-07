# Linear Agent Session API 能力参考

基于 `@linear/sdk` 源码整理，涵盖 AgentSession 的触发方式、可用操作、信号系统等。

## 1. Session 触发方式

| 触发 | 方式 | SDK 方法 |
|------|------|---------|
| 用户 @mention agent | Linear 自动创建 session → 发 webhook | 被动接收 `AgentSessionEvent.created` |
| 用户 delegate issue 给 agent | Linear 自动创建 session → 发 webhook | 被动接收 `AgentSessionEvent.created` |
| 用户在已有 session 继续回复 | Linear 发 webhook | 被动接收 `AgentSessionEvent.prompted` |
| Agent 主动在 issue 上创建 session | Agent 调 API | `client.agentSessionCreateOnIssue({ issueId })` |
| Agent 主动在 comment 上创建 session | Agent 调 API | `client.agentSessionCreateOnComment({ commentId })` |

## 2. Agent 可用操作

### 2.1 发送 Activity（核心能力）

所有 activity 通过 `client.createAgentActivity(input)` 发送。

| 类型 | content 格式 | 说明 |
|------|-------------|------|
| 思考 | `{ type: "thought", body: "分析中..." }` | 展示 agent 的推理过程，用户可见但不算正式回复 |
| 操作 | `{ type: "action", action: "工具名", parameter: "参数", result?: "结果" }` | 展示工具调用过程和结果 |
| 回复 | `{ type: "response", body: "最终回复" }` | 最终回复，**发送后 session 自动变为 complete** |
| 错误 | `{ type: "error", body: "错误信息" }` | 报告错误，session 变为 error 状态 |
| 提问 | `{ type: "elicitation", body: "你指哪个包？" }` | 向用户提问，session 变为 awaitingInput |

**Activity 可选字段：**
- `signal` — 附加信号（见下方信号系统）
- `signalMetadata` — 信号元数据（JSON）
- `ephemeral` — 是否为临时 activity（下一个 activity 到来后自动消失）
- `contextualMetadata` — 用户提供的上下文元数据

### 2.2 Session 管理

| 操作 | SDK 方法 | 说明 |
|------|---------|------|
| 更新执行计划 | `client.updateAgentSession(id, { plan })` | 在 Linear UI 中展示进度 checklist |
| 添加外部链接 | `client.agentSessionUpdateExternalUrl(id, { addedExternalUrls: [{ label, url }] })` | 如 PR 链接、CI 链接、部署链接 |
| 移除外部链接 | `client.agentSessionUpdateExternalUrl(id, { removedExternalUrls: ["url"] })` | 清理不再有效的链接 |
| 查询 session | `client.agentSession(id)` | 获取 session 详情 |
| 查询对话历史 | `(await client.agentSession(id)).activities()` | 获取所有 activity（不可变快照） |
| 主动创建 session | `client.agentSessionCreateOnIssue({ issueId })` | 在指定 issue 上主动发起会话 |

### 2.3 执行计划（Plan）

通过 `updateAgentSession` 更新 plan 字段，Linear UI 会渲染为 checklist：

```typescript
await client.updateAgentSession(sessionId, {
  plan: [
    { content: "分析 issue 描述", status: "completed" },
    { content: "阅读相关代码", status: "inProgress" },
    { content: "编写修复代码", status: "pending" },
    { content: "运行测试", status: "pending" },
  ]
});
```

plan item 的 status 值：`"pending"` | `"inProgress"` | `"completed"` | `"canceled"`

**注意：** 每次更新会替换整个 plan，需要包含所有步骤。

### 2.4 外部链接（External Links）

在 session 上附加外部资源链接，用户可在 Linear UI 中直接点击：

```typescript
await client.agentSessionUpdateExternalUrl(sessionId, {
  addedExternalUrls: [
    { label: "Pull Request", url: "https://github.com/org/repo/pull/123" },
    { label: "CI Pipeline", url: "https://ci.example.com/build/456" },
  ]
});
```

## 3. 信号系统（Signal）

Signal 是附加在 activity 上的元数据，修改 activity 的解释方式。

### 3.1 用户 → Agent

| Signal | 触发方式 | Agent 应如何响应 |
|--------|---------|-----------------|
| `stop` | 用户点击 Linear UI 中的"停止" | 立即停止所有操作，发送 response 或 error 确认 |

### 3.2 Agent → 用户

| Signal | 配合的 activity 类型 | 用途 |
|--------|---------------------|------|
| `auth` | `elicitation` | 需要用户完成第三方 OAuth 认证 |
| `select` | `elicitation` | 向用户展示选项列表让其选择 |
| `continue` | 任意 | 表示 agent 将继续处理 |

**auth 信号示例：**

```typescript
await client.createAgentActivity({
  agentSessionId: sessionId,
  content: { type: "elicitation", body: "请先完成 GitHub 认证" },
  signal: "auth",
  signalMetadata: {
    url: "https://github.com/login/oauth/authorize?...",
    providerName: "GitHub",
  },
});
```

Linear 会渲染认证 UI，用户完成认证后 agent 收到 `prompted` 事件继续工作。

**select 信号示例：**

```typescript
await client.createAgentActivity({
  agentSessionId: sessionId,
  content: { type: "elicitation", body: "你指的是哪个包？" },
  signal: "select",
  signalMetadata: {
    options: [
      { label: "frontend", value: "src/packages/frontend" },
      { label: "backend", value: "src/packages/backend" },
      { label: "shared", value: "src/packages/shared" },
    ],
  },
});
```

用户选择后，选中的值以 `prompted` 事件发送回来。用户也可以输入自由文本。

## 4. Session 状态流转

```
pending → active → complete
              ↓ → awaitingInput → active (用户回复后)
              ↓ → error
              ↓ → stale (30 分钟无活动，可恢复)
```

| 状态 | 含义 | 触发条件 |
|------|------|---------|
| `pending` | 等待 agent 响应 | session 创建后 |
| `active` | Agent 正在工作 | agent 发送第一个 activity 后 |
| `awaitingInput` | 等待用户输入 | agent 发送 elicitation 后 |
| `complete` | 工作完成 | agent 发送 response 后（自动） |
| `error` | 工作异常 | agent 发送 error 后 |
| `stale` | 超时 | 30 分钟无 activity（可通过发送新 activity 恢复） |

## 5. Webhook Payload 关键字段

`AgentSessionEvent.created` 的 payload 中包含丰富上下文：

| 字段 | 说明 |
|------|------|
| `agentSession` | session 详情（id, issueId, status, comment 等） |
| `appUserId` | agent 的用户 ID |
| `previousComments` | issue 上之前的评论（含用户 @mention 的内容） |
| `promptContext` | Linear 格式化的上下文字符串（issue 标题、描述、状态等） |
| `guidance` | 工作区/团队级别的 agent 行为指导规则 |
| `agentActivity` | 触发事件的 activity（仅 prompted/stopped 事件） |

## 6. 时序约束

| 约束 | 时间 | 说明 |
|------|------|------|
| 首次响应 | **10 秒** | 收到 `created` 后必须发送第一个 thought |
| Webhook 返回 | **5 秒** | HTTP 200 必须在 5 秒内返回 |
| 活动超时 | **30 分钟** | 超过 30 分钟无 activity → stale |
| Webhook 重试 | 1 分钟 / 1 小时 / 6 小时 | 失败后最多重试 3 次 |
