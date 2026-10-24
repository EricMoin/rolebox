export interface TeamDelivery {
  id: string;
  throughSeq: number;
  startedAt: number;
  ownerPid: number;
  ownerId: string;
  baselineMessageIds: string[];
  promptId?: string;
}

export interface TeamMember {
  id: string;
  roleId: string;
  sessionId?: string;
  status: "active" | "removed";
  managed: boolean;
  cursor: number;
  lastTurnId?: string;
  delivery?: TeamDelivery;
  error?: string;
}

export interface TeamEvent {
  seq: number;
  id: string;
  type: string;
  sender: string;
  content: string;
  recipient?: string;
  taskId?: string;
  at: number;
  wake: boolean;
}

export interface TeamTask {
  id: string;
  description: string;
  status: "offered" | "claimed" | "completed";
  owner?: string;
  leaseUntil?: number;
  result?: string;
}

export interface TeamControl {
  id: string;
  ownerPid: number;
  ownerId: string;
}

export interface TeamState {
  version: 1;
  id: string;
  name: string;
  goal: string;
  ownerSessionId: string;
  ownerRoleId: string;
  platformId: string;
  status: "active" | "paused" | "deleted";
  createdAt: number;
  nextSeq: number;
  maxTurns: number;
  turns: number;
  control?: TeamControl;
  members: TeamMember[];
  events: TeamEvent[];
  tasks: TeamTask[];
}
