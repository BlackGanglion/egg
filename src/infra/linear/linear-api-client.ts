import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LinearClient,
  type Comment,
  type Issue,
  type IssueLabel,
  type User,
  type WorkflowState,
} from "@linear/sdk";
import type {
  LinearIssueContext,
  LinearIssueContextLookup,
  LinearIssueContextOverview,
  LinearIssueContextPage,
  LinearIssueContextPageLookup,
  LinearIssueDetailSection,
  LinearIssueUpdate,
  LinearIssueWriter,
  LinearIssueReader,
} from "../../agent/sub/linear/tools";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const COMMENT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface LinearApiClientOptions {
  accessToken?: string;
  tokenStorePath?: string;
  clientId?: string;
  clientSecret?: string;
}

interface StoredTokenSet {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
  agentId?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LinearConnectionLike<TNode> {
  nodes: TNode[];
  pageInfo?: {
    hasNextPage?: boolean | null;
    endCursor?: string | null;
  } | null;
}

export class LinearApiClient implements LinearIssueReader, LinearIssueWriter {
  private cachedClient: LinearClient | null = null;
  private cachedToken = "";
  private cachedTokenSet?: StoredTokenSet;

  constructor(private readonly options: LinearApiClientOptions = {}) {}

  async fetchIssueContext(
    input: LinearIssueContextLookup,
  ): Promise<LinearIssueContext | null> {
    const client = await this.client();
    const issue = await this.getIssue(client, input);
    if (!issue) return null;

    const [state, team, assignee, issueLabels, viewer] = await Promise.all([
      issue.state,
      issue.team,
      issue.assignee,
      issue.labels({ first: DEFAULT_PAGE_SIZE }),
      this.getViewer(client),
    ]);
    if (!team) return null;

    const includeTeamContext = input.includeTeamContext !== false;
    const includeComments = input.includeComments !== false;
    const [members, availableLabels, workflowStates, comments] = await Promise.all([
      includeTeamContext
        ? team.members({ first: DEFAULT_PAGE_SIZE })
        : Promise.resolve(undefined),
      includeTeamContext
        ? team.labels({ first: DEFAULT_PAGE_SIZE })
        : Promise.resolve(undefined),
      includeTeamContext
        ? team.states({ first: DEFAULT_PAGE_SIZE })
        : Promise.resolve(undefined),
      includeComments
        ? issue.comments({ first: COMMENT_PAGE_SIZE })
        : Promise.resolve(undefined),
    ]);

    return {
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      url: issue.url,
      teamId: team.id,
      teamKey: team.key,
      teamName: team.name,
      assignee: assignee ? normalizeUser(assignee) : undefined,
      currentState: state ? normalizeWorkflowState(state) : undefined,
      workflowStates: workflowStates?.nodes.map(normalizeWorkflowState) ?? [],
      teamMembers:
        members?.nodes
          .filter((member) => member.active && member.id !== viewer?.id)
          .map(normalizeUser) ?? [],
      availableLabels: availableLabels?.nodes.map(normalizeLabel) ?? [],
      comments: await normalizeComments(comments?.nodes ?? []),
      existing: {
        hasPriority: issue.priority > 0,
        priority: issue.priority,
        hasLabels: issueLabels.nodes.length > 0,
        labelNames: issueLabels.nodes.map((label) => label.name),
      },
    };
  }

  async fetchIssueContextPage(
    input: LinearIssueContextPageLookup,
  ): Promise<LinearIssueContextPage | null> {
    const client = await this.client();
    const issue = await this.getIssue(client, input);
    if (!issue) return null;

    const section = input.section ?? "overview";
    if (section === "overview") {
      const context = await this.fetchIssueContext({
        issueId: issue.id,
        identifier: issue.identifier,
        includeComments: false,
        includeTeamContext: true,
      });
      if (!context) return null;

      return {
        issueId: context.issueId,
        identifier: context.identifier,
        section: "overview",
        items: [overviewFromContext(context)],
        pageInfo: {
          limit: 1,
          hasMore: false,
        },
      };
    }

    const limit = pageLimit(input.limit);
    if (section === "comments") {
      const connection = await issue.comments({
        first: limit,
        after: input.cursor,
      });
      return pageFromConnection({
        issue,
        section,
        limit,
        cursor: input.cursor,
        connection,
        items: await normalizeComments(connection.nodes),
      });
    }

    const team = await issue.team;
    if (!team) return null;

    if (section === "teamMembers") {
      const [viewer, connection] = await Promise.all([
        this.getViewer(client),
        team.members({ first: limit, after: input.cursor }),
      ]);

      return pageFromConnection({
        issue,
        section,
        limit,
        cursor: input.cursor,
        connection,
        items: connection.nodes
          .filter((member) => member.active && member.id !== viewer?.id)
          .map(normalizeUser),
      });
    }

    if (section === "availableLabels") {
      const connection = await team.labels({ first: limit, after: input.cursor });
      return pageFromConnection({
        issue,
        section,
        limit,
        cursor: input.cursor,
        connection,
        items: connection.nodes.map(normalizeLabel),
      });
    }

    const connection = await team.states({ first: limit, after: input.cursor });
    return pageFromConnection({
      issue,
      section,
      limit,
      cursor: input.cursor,
      connection,
      items: connection.nodes.map(normalizeWorkflowState),
    });
  }

  async updateIssue(issueId: string, input: LinearIssueUpdate): Promise<unknown> {
    const client = await this.client();
    return client.updateIssue(issueId, input);
  }

  async createComment(issueId: string, body: string): Promise<unknown> {
    const client = await this.client();
    return client.createComment({ issueId, body });
  }

  private async client(): Promise<LinearClient> {
    const token = await this.accessToken();
    if (!this.cachedClient || this.cachedToken !== token) {
      this.cachedClient = new LinearClient({ accessToken: token });
      this.cachedToken = token;
    }
    return this.cachedClient;
  }

  private async getIssueByIdentifier(
    client: LinearClient,
    identifier: string | undefined,
  ): Promise<Issue | null> {
    const parsed = parseIssueIdentifier(identifier);
    if (!parsed) return null;

    const issues = await client.issues({
      filter: {
        number: { eq: parsed.number },
        team: { key: { eq: parsed.teamKey } },
      },
      first: 1,
    });
    return issues.nodes[0] ?? null;
  }

  private async getIssue(
    client: LinearClient,
    input: LinearIssueContextLookup,
  ): Promise<Issue | null> {
    return input.issueId
      ? client.issue(input.issueId)
      : this.getIssueByIdentifier(client, input.identifier);
  }

  private async getViewer(client: LinearClient): Promise<User | undefined> {
    try {
      return await client.viewer;
    } catch {
      return undefined;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.options.accessToken) return this.options.accessToken;

    const tokenSet = await this.loadTokenSet();
    if (!tokenSet?.accessToken) {
      throw new Error(
        "Linear access token is not configured. Set LINEAR_ACCESS_TOKEN or provide LINEAR_TOKEN_STORE_PATH.",
      );
    }

    if (tokenSet.expiresAt && this.shouldRefresh(tokenSet.expiresAt)) {
      const refreshed = await this.refreshToken(tokenSet);
      if (refreshed?.accessToken) return refreshed.accessToken;

      if (Date.now() >= new Date(tokenSet.expiresAt).getTime()) {
        throw new Error("Linear access token expired and refresh failed");
      }
    }

    return tokenSet.accessToken;
  }

  private async loadTokenSet(): Promise<StoredTokenSet | null> {
    if (this.cachedTokenSet) return this.cachedTokenSet;
    if (!this.options.tokenStorePath) return null;

    try {
      const raw = await readFile(this.options.tokenStorePath, "utf8");
      this.cachedTokenSet = JSON.parse(raw) as StoredTokenSet;
      return this.cachedTokenSet;
    } catch {
      return null;
    }
  }

  private shouldRefresh(expiresAt: string): boolean {
    return Date.now() > new Date(expiresAt).getTime() - TOKEN_REFRESH_BUFFER_MS;
  }

  private async refreshToken(existing: StoredTokenSet): Promise<StoredTokenSet | null> {
    if (!this.options.clientId || !this.options.clientSecret || !existing.refreshToken) {
      return null;
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: existing.refreshToken,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });

    const response = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }).catch(() => null);

    if (!response?.ok) return null;
    const payload = (await response.json().catch(() => null)) as
      | {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          token_type?: string;
          scope?: string;
        }
      | null;
    if (!payload?.access_token) return null;

    const now = new Date();
    const refreshed: StoredTokenSet = {
      ...existing,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? existing.refreshToken,
      tokenType: payload.token_type ?? existing.tokenType,
      scope: payload.scope ?? existing.scope,
      expiresAt:
        typeof payload.expires_in === "number"
          ? new Date(now.getTime() + payload.expires_in * 1000).toISOString()
          : existing.expiresAt,
      updatedAt: now.toISOString(),
    };

    await this.saveTokenSet(refreshed);
    this.cachedTokenSet = refreshed;
    this.cachedToken = refreshed.accessToken ?? "";
    return refreshed;
  }

  private async saveTokenSet(tokenSet: StoredTokenSet): Promise<void> {
    if (!this.options.tokenStorePath) return;

    await mkdir(dirname(this.options.tokenStorePath), { recursive: true });
    await writeFile(
      this.options.tokenStorePath,
      `${JSON.stringify(tokenSet, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

function parseIssueIdentifier(
  identifier: string | undefined,
): { teamKey: string; number: number } | null {
  const match = identifier?.trim().match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  if (!match?.[1] || !match[2]) return null;

  return {
    teamKey: match[1].toUpperCase(),
    number: Number.parseInt(match[2], 10),
  };
}

function overviewFromContext(
  context: LinearIssueContext,
): LinearIssueContextOverview {
  return {
    issueId: context.issueId,
    identifier: context.identifier,
    title: context.title,
    description: context.description,
    url: context.url,
    teamId: context.teamId,
    teamKey: context.teamKey,
    teamName: context.teamName,
    assignee: context.assignee,
    currentState: context.currentState,
    workflowStates: context.workflowStates,
    existing: context.existing,
    sections: sectionRequests(context),
  };
}

function sectionRequests(
  context: LinearIssueContext,
): LinearIssueContextOverview["sections"] {
  const base = {
    issueId: context.issueId,
    identifier: context.identifier,
    limit: COMMENT_PAGE_SIZE,
  };

  return {
    comments: {
      tool: "fetch_linear_issue_comments",
      description: "Issue comments.",
      request: base,
    },
    teamMembers: {
      tool: "fetch_linear_issue_team_members",
      description: "Assignable team members.",
      request: base,
    },
    availableLabels: {
      tool: "fetch_linear_issue_labels",
      description: "Available issue labels.",
      request: base,
    },
    workflowStates: {
      tool: "fetch_linear_issue_workflow_states",
      description: "Team workflow states.",
      request: base,
    },
  };
}

function pageFromConnection<TItem, TNode>(input: {
  issue: Issue;
  section: LinearIssueDetailSection;
  limit: number;
  cursor?: string;
  connection: LinearConnectionLike<TNode>;
  items: TItem[];
}): LinearIssueContextPage<TItem> {
  return {
    issueId: input.issue.id,
    identifier: input.issue.identifier,
    section: input.section,
    items: input.items,
    pageInfo: {
      limit: input.limit,
      cursor: input.cursor,
      nextCursor: input.connection.pageInfo?.hasNextPage
        ? input.connection.pageInfo.endCursor ?? undefined
        : undefined,
      hasMore: input.connection.pageInfo?.hasNextPage === true,
    },
  };
}

function pageLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return COMMENT_PAGE_SIZE;
  }

  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(value)));
}

function normalizeUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName,
  };
}

function normalizeLabel(label: IssueLabel) {
  return {
    id: label.id,
    name: label.name,
  };
}

function normalizeWorkflowState(state: WorkflowState) {
  return {
    id: state.id,
    name: state.name,
    type: state.type,
  };
}

async function normalizeComments(comments: Comment[]) {
  return Promise.all(
    comments.map(async (comment) => {
      const user = await comment.user?.catch(() => undefined);
      return {
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        user: user ? normalizeUser(user) : undefined,
      };
    }),
  );
}
