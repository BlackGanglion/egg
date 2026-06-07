# Linear Webhook 事件类型

Linear 通过 webhook 向 agent 推送事件，所有事件共享统一的 payload 结构，通过 `type` 字段区分类型。

## Payload 通用结构

```json
{
  "type": "事件类型",
  "action": "操作类型",
  "createdAt": "ISO 时间戳",
  "organizationId": "工作区 ID",
  "webhookId": "投递唯一 ID（用于去重）",
  "webhookTimestamp": 1234567890,
  "data": { ... },
  "url": "实体 URL"
}
```

注意：不同 type 的 payload 结构差异较大，部分字段（如 `data`）在某些类型中为空，数据在其他字段中（如 `agentSession`）。

## 事件类型详解

### AgentSessionEvent

**Agent 会话事件** — Agent 与用户在 issue 上的对话会话。

| action | 触发时机 | 说明 |
|--------|---------|------|
| `created` | 用户 @mention agent 或 delegate issue 给 agent | 新建会话，agent 需 10 秒内响应 |
| `prompted` | 用户在已有 session 中发送新消息 | 继续对话 |
| `stopped` | 用户点击"停止" | agent 必须立即停止操作 |

**数据位置：** `payload.agentSession` 字段（非 `payload.data`）

**关键字段：**
- `agentSession.id` — 会话 ID
- `agentSession.issueId` — 关联的 issue ID
- `agentSession.status` — 会话状态（pending/active/complete/error/stale）
- `appUserId` — agent 的 ID
- `previousComments` — 之前的评论列表（含用户消息）
- `promptContext` — 格式化的上下文信息（issue 标题、描述等）

---

### Issue

**Issue 事件** — issue 的创建、修改、删除。

| action | 触发时机 | 说明 |
|--------|---------|------|
| `create` | 新建 issue | 可用于自动分诊（分配优先级/标签/负责人） |
| `update` | 修改 issue（状态、分配人、描述等） | 可检测 issue 是否 assign/delegate 给 agent |
| `remove` | 删除 issue | 通常不需处理 |

**数据位置：** `payload.data` 字段

**关键字段：**
- `data.id` — issue ID
- `data.identifier` — 可读标识（如 "MOV-6"）
- `data.title` — 标题
- `data.assigneeId` — 负责人 ID
- `data.stateId` — 当前状态 ID
- `data.teamId` — 所属团队 ID
- `data.priority` — 优先级（0=无, 1=紧急, 4=低）

---

### Comment

**评论事件** — issue 上的评论创建。

| action | 触发时机 | 说明 |
|--------|---------|------|
| `create` | 用户或 agent 发布评论 | 包含评论内容和作者信息 |

**数据位置：** `payload.data` 字段

**关键字段：**
- `data.id` — 评论 ID
- `data.body` — 评论内容（Markdown）
- `data.issueId` — 关联 issue ID
- `data.userId` — 作者 ID
- `data.user.name` — 作者名称

**注意：** 当 agent 发送 response activity 时，Linear 会自动生成一条 Comment，并以 webhook 回发。需要通过 `actorId === agentId` 过滤，防止回环。

---

### AppUserNotification

**应用用户通知** — Linear 发送给 OAuth 应用的通知。

| notification.type | 含义 |
|-------------------|------|
| `issueMention` | agent 在 issue 中被 @mention |
| `issueCommentMention` | agent 在评论中被 @mention |
| `issueAssignedToYou` | issue 被分配给 agent |
| `issueEmojiReaction` | agent 收到 emoji 回应 |
| `issueStatusChanged` | 关注的 issue 状态变更 |

**数据位置：** `payload.notification` 字段

**处理建议：忽略。** 该事件与 AgentSessionEvent / Comment / Issue 事件重复。如果同时处理会导致 agent 重复执行。参考项目均选择丢弃此类事件。

---

### PermissionChange

**权限变更事件** — agent 在工作区中的团队访问权限发生变化。

| 字段 | 说明 |
|------|------|
| `addedTeamIds` | 新获得访问权限的团队 ID 列表 |
| `removedTeamIds` | 失去访问权限的团队 ID 列表 |

**触发时机：** 工作区管理员修改 OAuth 应用的团队权限。

**处理建议：** 可选处理。可用于动态调整 agent 服务的团队范围。

---

### OAuthApp / OAuthAuthorization

**OAuth 授权事件** — OAuth 应用的授权状态变更。

**触发时机：**
- OAuth 应用被安装到工作区
- OAuth 应用被撤销授权
- OAuth 应用凭证发生变更

**处理建议：** 可选处理。可用于检测授权撤销并清理本地 token。

---

## 处理优先级

| 优先级 | type | 用途 |
|--------|------|------|
| **必须处理** | AgentSessionEvent | agent 对话的核心链路 |
| **推荐处理** | Issue (update) | 检测 assign/delegate 给 agent |
| **可选处理** | Issue (create) | 自动分诊新 issue |
| **应当忽略** | AppUserNotification | 与其他事件重复 |
| **可选处理** | Comment (create) | 检测 @mention（仅在无 AgentSession 时兜底） |
| **可选处理** | PermissionChange | 团队权限感知 |
| **可选处理** | OAuthApp | 授权状态感知 |

## 与文档的差异

实际测试中发现 Linear 发送的 webhook 与官方文档存在以下差异：

| 项目 | 文档描述 | 实际行为 |
|------|---------|---------|
| 事件类型名 | `AgentSession` | `AgentSessionEvent` |
| action 值 | `create` / `update` | `created` / `prompted` / `stopped`（过去式/具体动作） |
| 数据位置 | `payload.data` | `payload.agentSession`（`data` 为空） |
| 用户消息 | `data.message` | `previousComments[last].body` 或 `promptContext` |

Linear Agent API 处于 Developer Preview 阶段，以上差异可能在后续版本中变化。建议同时兼容两种格式。
