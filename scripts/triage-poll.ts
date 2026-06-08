/**
 * 单独启动 Linear issue 轮询补偿链路。
 * 用法: npm run triage:poll
 */
import { loadConfig } from "../src/utils/config";
import { createLogger } from "../src/utils/logger";
import { getAccessToken, type OAuthConfig } from "../src/infra/linear/oauth";
import { LinearApiClient } from "../src/infra/linear/client";
import { createLinearTriageAgent } from "../src/agent/sub/linear-triage";
import { LinearIssuePoller } from "../src/agent/sub/linear-triage/poller";

async function main() {
  const config = loadConfig();
  const logger = createLogger("log");

  const oauthConfig: OAuthConfig = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    webhookSecret: config.webhookSecret,
    tokenStorePath: config.tokenStorePath,
  };

  const tokenResult = await getAccessToken(oauthConfig);
  if (!tokenResult) {
    console.error("无可用的 OAuth token，请先通过 /oauth/authorize 授权");
    process.exit(1);
  }

  const linearClient = new LinearApiClient(async () => {
    const result = await getAccessToken(oauthConfig);
    if (!result) throw new Error("OAuth token 失效");
    return result.accessToken;
  });

  const llmConfig = {
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    apiKey: config.llmApiKey,
  };

  const triageAgent = createLinearTriageAgent(linearClient, llmConfig, logger);
  const poller = new LinearIssuePoller(
    linearClient,
    triageAgent,
    logger,
    config.triageMinIssueNumber,
  );

  poller.start();

  function shutdown() {
    logger.info("[issue-poller] stopping");
    poller.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
