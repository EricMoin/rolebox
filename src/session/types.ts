export type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

export type SessionInfo = {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: Array<FileDiff>;
  };
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    compacting?: number;
  };
};

export type MessageInfo = {
  id: string;
  sessionID: string;
  /**
   * Speaker role. "user" | "assistant" are the canonical harness roles;
   * adapter-specific roles (e.g. pi's "toolResult") are preserved as-is
   * so tool-result content is never misclassified as assistant text.
   */
  role: "user" | "assistant" | (string & {});
  time: {
    created: number;
    completed?: number;
  };
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  error?: unknown;
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  path?: {
    cwd: string;
    root: string;
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  finish?: string;
};

export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
};

export type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  time: {
    start: number;
    end?: number;
  };
};

export type ToolStateCompleted = {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
};

export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state:
    | { status: "pending" | "running"; input: Record<string, unknown> }
    | ToolStateCompleted
    | { status: "error"; error: string; time: { start: number; end: number } };
};

export type StepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

export type Part = TextPart | ReasoningPart | ToolPart | StepFinishPart | {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  [key: string]: unknown;
};

export type Message = {
  info: MessageInfo;
  parts: Array<Part>;
};

export type Todo = {
  content: string;
  status: string;
  priority: string;
  id: string;
};

export type SessionStatus = {
  type: "idle";
} | {
  type: "retry";
  attempt: number;
  message: string;
  next: number;
} | {
  type: "busy";
};

export type SessionStats = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  toolFrequencies: Record<string, number>;
  modelDistribution: Record<string, number>;
  totalAdditions: number;
  totalDeletions: number;
  filesModified: number;
  diffs: FileDiff[];
};

export type SearchMatch = {
  sessionID: string;
  sessionTitle: string;
  messageID: string;
  role: string;
  text: string;
  contextBefore: string;
  contextAfter: string;
};

export type ToolContext = {
  sessionID: string;
  agent: string;
  directory: string;
};
