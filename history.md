# 优化记录

## 2026-04-02

- **Webhook 缺口检测与自动补漏** — 通过内存跟踪每个团队前缀的 issue 编号序列，当检测到编号跳跃时自动通过 API 拉取遗漏的 issue 并补跑 triage，所有缺口事件以 `[webhook-gap]` 前缀记录日志
- **日志时区修正** — 日志时间戳和日志文件名统一使用 Asia/Shanghai 时区（UTC+8），避免服务器时区不一致导致的困惑
- **网络重试机制** — 为 `triageIssue` 增加指数退避重试（最多 3 次），应对 LLM 调用等环节的瞬时网络故障
- **多模态 Triage 支持** — 自动提取 issue 描述中的图片，下载后以 base64 编码发送给 LLM，使 triage 判断能参考截图等视觉信息

## 2026-04-01

- **Webhook 诊断日志** — 为 webhook 端点增加详细的请求诊断日志，辅助排查图片相关问题
- **LLM Triage 资格预判** — 新增 LLM 判断 issue 是否适合自动 triage 的能力，不适合的 issue 跳过处理；triage 完成后自动将 issue 从 triage 状态迁移到 backlog
- **文档更新** — 重写设计文档适配独立架构，README 补充管理员前置条件说明
- **LLM 输出格式优化** — 通过 `response_format: json_object` 强制 LLM 返回 JSON，简化 `parseResult` 解析逻辑
