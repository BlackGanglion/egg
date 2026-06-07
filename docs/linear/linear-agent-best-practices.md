# Linear Agent 最佳实践

## 响应时效

- 收到 `created` webhook 后，**必须在 10 秒内**发送一个 `thought` activity 确认已开始工作
- 后续 activity 可在 30 分钟内持续发送
- 超过 30 分钟无 activity，session 变为 stale（可通过发送新 activity 恢复）

## Issue 状态管理

当 agent 被 delegate 处理一个 issue 时，如果 issue 不在 `started`、`completed` 或 `canceled` 状态，应主动将其移到第一个 `started` 状态：

1. 查询 team 的 workflow states，筛选 `type: { eq: "started" }`
2. 选择 `position` 值最小的状态
3. 更新 issue 状态

## Delegate 设置

如果 agent 正在处理 issue 且当前没有 `Issue.delegate`，应将自己设为 delegate，使 agent 在 issue 中的角色更明确。

## 工作完成

根据结果发送不同类型的 activity：

| 结果 | Activity 类型 |
|------|--------------|
| 工作完成 | `response` |
| 需要用户进一步操作 | `elicitation` |
| 工作失败 | `error` |

## 对话历史：使用 Agent Activities 而非 Comments

> Comments may not be reliable to read from, as they are editable and may have changed since your agent's last run.

**不要从 comments 读取对话历史**，因为 comments 可被编辑。应依赖 **Agent Activities**，它们是不可变的用户输入快照。

Activity 内容类型：
- `AgentActivityThoughtContent` — 思考过程
- `AgentActivityActionContent` — 操作执行
- `AgentActivityElicitationContent` — 向用户提问
- `AgentActivityResponseContent` — 最终响应
- `AgentActivityErrorContent` — 错误信息
- `AgentActivityPromptContent` — 用户输入（只读，agent 不可生成）

## 额外 Webhook 类别

### Inbox Notifications

agent 被取消分配或收到 reaction 时触发。可用的 action 类型：
- `issueMention` — 被 mention
- `issueEmojiReaction` — 收到 emoji reaction
- `issueAssignedToYou` — 被分配 issue
- `issueStatusChanged` — issue 状态变更

### Permission Changes

agent 获得或失去 team 访问权限时触发，payload 包含 `addedTeamIds` 和 `removedTeamIds`。单独的 webhook 也会在 OAuth app 被撤销时触发。

## 社区支持

如有问题或反馈，可加入 Linear 社区 Slack 的 **#api** 频道。
