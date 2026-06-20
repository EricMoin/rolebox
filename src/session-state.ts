export class FunctionSessionState {
  private sessions: Map<string, Set<string>> = new Map();

  activate(sessionID: string, functionNames: string[]): void {
    if (!this.sessions.has(sessionID)) {
      this.sessions.set(sessionID, new Set());
    }
    const active = this.sessions.get(sessionID)!;
    for (const name of functionNames) {
      active.add(name);
    }
  }

  getActive(sessionID: string): Set<string> {
    return this.sessions.get(sessionID) ?? new Set();
  }

  isActive(sessionID: string, functionName: string): boolean {
    return this.sessions.get(sessionID)?.has(functionName) ?? false;
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID);
  }
}

export const functionSessionState = new FunctionSessionState();
