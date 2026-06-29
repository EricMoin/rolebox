import type { FunctionCall } from "./function-parser.ts";

export class FunctionSessionState {
  private sessions: Map<string, Set<string>> = new Map();
  private callArgs: Map<string, Map<string, FunctionCall>> = new Map();
  private locked: Map<string, Set<string>> = new Map();

  activate(sessionID: string, functionNames: string[], calls?: FunctionCall[]): void {
    if (!this.sessions.has(sessionID)) {
      this.sessions.set(sessionID, new Set());
    }
    const active = this.sessions.get(sessionID)!;
    for (const name of functionNames) {
      active.add(name);
    }

    if (calls && calls.length > 0) {
      if (!this.callArgs.has(sessionID)) {
        this.callArgs.set(sessionID, new Map());
      }
      const argsMap = this.callArgs.get(sessionID)!;
      for (const call of calls) {
        argsMap.set(call.name, call);
      }
    }
  }

  activateDefaults(sessionID: string, functionNames: string[], lockedNames?: string[]): void {
    this.activate(sessionID, functionNames);
    if (lockedNames && lockedNames.length > 0) {
      if (!this.locked.has(sessionID)) {
        this.locked.set(sessionID, new Set());
      }
      const lockedSet = this.locked.get(sessionID)!;
      for (const name of lockedNames) {
        if (functionNames.includes(name)) {
          lockedSet.add(name);
        }
      }
    }
  }

  getActive(sessionID: string): Set<string> {
    return this.sessions.get(sessionID) ?? new Set();
  }

  getCall(sessionID: string, functionName: string): FunctionCall | undefined {
    return this.callArgs.get(sessionID)?.get(functionName);
  }

  isActive(sessionID: string, functionName: string): boolean {
    return this.sessions.get(sessionID)?.has(functionName) ?? false;
  }

  deactivate(sessionID: string, functionName: string): void {
    const lockedSet = this.locked.get(sessionID);
    if (lockedSet?.has(functionName)) return;
    this.sessions.get(sessionID)?.delete(functionName);
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID);
    this.callArgs.delete(sessionID);
    this.locked.delete(sessionID);
  }
}

export const functionSessionState = new FunctionSessionState();
