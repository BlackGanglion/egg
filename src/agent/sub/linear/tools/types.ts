export interface LinearWorkflowState {
  id: string;
  name?: string;
  type: string;
}

export interface LinearIssueExistingState {
  hasPriority: boolean;
  priority?: number;
  hasLabels: boolean;
  labelNames?: string[];
}

export interface LinearTriageContext {
  issueId: string;
  identifier?: string;
  currentState?: LinearWorkflowState;
  workflowStates: LinearWorkflowState[];
  existing: LinearIssueExistingState;
}

export interface LinearTeamMember {
  id: string;
  name: string;
  displayName?: string;
}

export interface LinearIssueLabel {
  id: string;
  name: string;
}

export interface LinearIssueComment {
  id: string;
  body: string;
  createdAt?: string;
  user?: LinearTeamMember;
}

export interface LinearIssueContext extends LinearTriageContext {
  title: string;
  description: string;
  url?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  assignee?: LinearTeamMember;
  teamMembers: LinearTeamMember[];
  availableLabels: LinearIssueLabel[];
  comments: LinearIssueComment[];
}

export interface LinearIssueUpdate {
  assigneeId?: string;
  priority?: number;
  labelIds?: string[];
  stateId?: string;
}

export interface LinearIssueContextLookup {
  issueId?: string;
  identifier?: string;
  includeComments?: boolean;
  includeTeamContext?: boolean;
}

export type LinearIssueContextSection =
  | "overview"
  | "comments"
  | "teamMembers"
  | "availableLabels"
  | "workflowStates";

export type LinearIssueDetailSection = Exclude<
  LinearIssueContextSection,
  "overview"
>;

export interface LinearIssueContextPageLookup extends LinearIssueContextLookup {
  section?: LinearIssueContextSection;
  cursor?: string;
  limit?: number;
}

export interface LinearIssueContextOverview extends LinearTriageContext {
  title: string;
  description: string;
  url?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  assignee?: LinearTeamMember;
  sections: Record<
    LinearIssueDetailSection,
    {
      tool: string;
      description: string;
      request: {
        issueId?: string;
        identifier?: string;
        cursor?: string;
        limit: number;
      };
    }
  >;
}

export interface LinearIssueContextPage<TItem = unknown> {
  issueId?: string;
  identifier?: string;
  section: LinearIssueContextSection;
  items: TItem[];
  pageInfo: {
    limit: number;
    cursor?: string;
    nextCursor?: string;
    hasMore: boolean;
  };
}

export interface LinearIssueReader {
  fetchIssueContext(input: LinearIssueContextLookup): Promise<LinearIssueContext | null>;
  fetchIssueContextPage(
    input: LinearIssueContextPageLookup,
  ): Promise<LinearIssueContextPage | null>;
}

export interface LinearIssueWriter {
  updateIssue(issueId: string, input: LinearIssueUpdate): Promise<unknown>;
  createComment(issueId: string, body: string): Promise<unknown>;
}

export interface LinearToolDependencies {
  issueReader?: LinearIssueReader;
  issueWriter?: LinearIssueWriter;
}
