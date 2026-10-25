import { describe, expect, it } from "vitest";
import { createDshGraphWorkerGrantHost } from "../../../../src/platform/adapters/dsh/graph-worker-host.ts";
import type { OutcomeWorkerPrincipal, OutcomeWorkerToolGrant } from "../../../../src/graph/host/tool-binding.ts";

const principal: OutcomeWorkerPrincipal = {
  graphId: "graph", attemptId: "work#1", executionId: "execution", workerSessionId: "worker",
};

describe("DSH worker grant routing", () => {
  it("reads the merged grant from the resolved owner without searching other workspaces again", () => {
    let probes = 0;
    let grants = 0;
    let current: OutcomeWorkerToolGrant = { declaredTools: ["docs_*"] };
    const unrelated = {
      workerPrincipalOf: () => { probes++; return undefined; },
      workerToolGrantOf: () => { throw new Error("not the worker's owner"); },
    };
    const owner = {
      workerPrincipalOf: () => { probes++; return principal; },
      workerToolGrantOf: () => { grants++; return current; },
    };
    const host = createDshGraphWorkerGrantHost(() => [unrelated, unrelated, owner]);
    expect(host.workerPrincipalOf("worker")).toBe(principal);
    expect(probes).toBe(3);
    expect(host.workerToolGrantOf!(principal)).toEqual({ declaredTools: ["docs_*"] });
    current = {};
    expect(host.workerToolGrantOf!(principal)).toEqual({});
    expect(probes).toBe(3);
    expect(grants).toBe(2);
  });

  it("retries an absent identity when another workspace becomes available", () => {
    const hosts: Array<{
      workerPrincipalOf: (sessionId: string) => OutcomeWorkerPrincipal | undefined;
      workerToolGrantOf: () => OutcomeWorkerToolGrant;
    }> = [];
    const host = createDshGraphWorkerGrantHost(() => hosts);
    expect(host.workerPrincipalOf("worker")).toBeUndefined();
    hosts.push({ workerPrincipalOf: id => id === "worker" ? principal : undefined,
      workerToolGrantOf: () => ({ declaredTools: ["docs_*"] }) });
    expect(host.workerPrincipalOf("worker")).toBe(principal);
    expect(host.workerToolGrantOf!(principal)).toEqual({ declaredTools: ["docs_*"] });
    hosts.length = 0;
    expect(host.workerToolGrantOf!(principal)).toEqual({});
  });

  it("checks every identity field when routing a principal it did not resolve", () => {
    const host = createDshGraphWorkerGrantHost(() => [{
      workerPrincipalOf: () => principal,
      workerToolGrantOf: () => ({ declaredTools: ["docs_*"] }),
    }]);
    expect(host.workerToolGrantOf!({ ...principal, executionId: "different" })).toEqual({});
    expect(host.workerToolGrantOf!({ ...principal })).toEqual({ declaredTools: ["docs_*"] });
  });
});
