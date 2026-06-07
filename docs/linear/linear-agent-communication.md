# Linear Agent 通讯机制

## 通讯架构

```
Linear ──(Webhook)──> Agent Server ──(GraphQL API)──> Linear
```

- **入方向**：Linear 通过 Webhook 推送事件给 Agent
- **出方向**：Agent 通过 GraphQL API 向 Linear 发送 Activity

---

## 入方向：Webhook

### 配置

在 OAuth Application 设置中：
1. 启用 Webhooks
2. 订阅 **Agent session events** 类别
3. 可选订阅 **Inbox notifications** 和 **Permission changes**

### Agent Session Events

两种事件类型：

| 事件 | 触发时机 |
|------|---------|
| `created` | 用户 @mention agent 或将 issue delegate 给 agent，创建新 session |
| `prompted` | 用户在已有 session 中发送新消息 |

### Webhook 要求

- 端点必须是**公网可达的 HTTPS URL**
- 必须在 **5 秒内**响应 HTTP 200
- 失败重试策略：最多 3 次（1 分钟、1 小时、6 小时后）
- 持续失败可能导致 webhook 被禁用

### Webhook Payload 结构

HTTP Headers：

| Header | 说明 |
|--------|------|
| `Linear-Event` | 事件实体类型 |
| `Linear-Signature` | HMAC-SHA256 签名 |
| `Linear-Delivery` | 唯一投递 ID |
| `User-Agent` | `Linear-Webhook` |

Payload 字段：

| 字段 | 说明 |
|------|------|
| `action` | 操作类型：create, update, remove |
| `type` | 实体类型 |
| `actor` | 触发操作的用户/应用 |
| `data` | 序列化的实体数据 |
| `url` | 实体 URL |
| `webhookTimestamp` | UNIX 毫秒时间戳 |

### 签名验证

```typescript
import crypto from "node:crypto";

function verifySignature(signature: string, rawBody: Buffer, secret: string): boolean {
  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(signature, "hex")
  );
}

// 使用时：
// 1. 从 req.headers["linear-signature"] 获取签名
// 2. 验证签名
// 3. 验证 webhookTimestamp 在 60 秒内（防重放攻击）
```

### Webhook 源 IP

```
35.231.147.226
35.243.134.228
34.140.253.14
34.38.87.206
34.134.222.122
35.222.25.142
```

---

## 出方向：GraphQL API

### API 端点

```
POST https://api.linear.app/graphql
Authorization: Bearer <access_token>
Content-Type: application/json
```

### 核心 Mutation

#### 发送 Agent Activity

```graphql
mutation {
  agentActivityCreate(
    input: {
      agentSessionId: "SESSION_ID"
      content: {
        type: "thought"
        body: "正在分析问题..."
      }
    }
  ) {
    success
  }
}
```

#### 更新 Agent Session

```graphql
mutation {
  agentSessionUpdate(
    id: "SESSION_ID"
    input: {
      externalUrl: "https://example.com/run/123"
    }
  ) {
    success
  }
}
```

### Activity 类型

| 类型 | 用途 | 说明 |
|------|------|------|
| `thought` | 中间思考过程 | 展示 agent 当前在做什么，收到 created 后必须 10 秒内发送 |
| `action` | 工具调用/操作 | 展示 agent 正在执行的具体操作 |
| `elicitation` | 向用户提问 | 需要用户输入时使用，支持 signal 增强 |
| `response` | 最终响应 | 工作完成时发送 |
| `error` | 错误 | 工作失败时发送 |

### 读取会话历史

不要从 comments 读取对话历史（comments 可能被编辑）。应通过 Agent Activities API 获取：

```graphql
query {
  agentSession(id: "SESSION_ID") {
    activities {
      nodes {
        content {
          ... on ThoughtContent { body }
          ... on PromptContent { body }
          ... on ResponseContent { body }
          ... on ErrorContent { body }
        }
      }
    }
  }
}
```
