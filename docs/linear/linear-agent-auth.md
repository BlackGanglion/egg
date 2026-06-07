# Linear Agent 授权机制

## OAuth 2.0 + actor=app

Linear Agent 使用标准 OAuth 2.0 流程，关键区别是在授权 URL 中加入 `actor=app` 参数。

### 授权流程

1. **创建 OAuth Application** — 在 Linear Settings > API 中创建应用，配置名称、图标、回调 URL
2. **发起授权请求** — 将用户引导到授权 URL，必须包含 `actor=app` 参数
3. **用户授权** — 需要 workspace admin 权限才能安装 agent
4. **Token 交换** — 用 authorization code 换取 access token 和 refresh token
5. **Token 刷新** — access token 24h 过期，需用 refresh token 刷新

### 授权 URL 示例

```
https://linear.app/oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=YOUR_REDIRECT_URI&
  response_type=code&
  scope=read,write,app:assignable,app:mentionable&
  actor=app
```

### 关键 Scopes

| Scope | 用途 | 优先级 |
|-------|------|--------|
| `read` | 读取 workspace 数据 | **必需** |
| `write` | 写入数据（创建/更新 issue、评论等） | **必需** |
| `app:assignable` | 使 agent 可被 assign/delegate issue | **必需** |
| `app:mentionable` | 使 agent 可在 issue/文档中被 @mention | **必需** |
| `customer:read` / `customer:write` | 客户数据读写（管理外部客户与 issue 的关联） | 可选 |
| `initiative:read` / `initiative:write` | Initiative 数据读写（高于 Project 的战略规划层级） | 可选 |

> 注意：使用 `actor=app` 的应用**不能**请求 `admin` scope。

### Token 交换

```
POST https://api.linear.app/oauth/token
Content-Type: application/x-www-form-urlencoded

code=AUTHORIZATION_CODE&
client_id=YOUR_CLIENT_ID&
client_secret=YOUR_CLIENT_SECRET&
redirect_uri=YOUR_REDIRECT_URI&
grant_type=authorization_code
```

### Workspace 身份

每个 workspace 安装后，agent 会获得**唯一的 ID**。通过以下查询获取：

```graphql
query Me {
  viewer {
    id
  }
}
```

应将此 ID 与 access token 一起存储，用于跨 workspace 识别。

### actor=app 的效果

所有通过该 token 发起的 mutation（创建 issue、评论、状态变更等）都将归属到**应用本身**，而非某个用户。

可通过 `createAsUser`（显示名称）和 `displayIconUrl`（头像 URL）自定义显示，效果为 "User (via Application)" 格式。
