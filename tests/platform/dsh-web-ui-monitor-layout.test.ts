import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const live = process.env.ROLEBOX_DSH_WEB_LAYOUT_LIVE === "1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const longText = "long_unbroken_identifier_".repeat(12);
const sessionId = "session-12345678-1234-4234-9234-123456789abc";
const nodes = Array.from({ length: 24 }, (_, index) => ({
  nodeId: `node-${index}-${longText}`,
  agent: longText,
  status: index === 0 ? "failed" : "running",
  dispatchSessionId: sessionId,
  dispatchTaskId: longText,
  signalType: longText,
  errorReason: index === 0 ? longText : undefined,
}));
const graph = {
  graphId: longText,
  phase: longText,
  nodeCount: nodes.length,
  nodeStatusCounts: { running: 23, failed: 1 },
  nodes,
  graph: {
    current: {},
    runs: [{ result: longText }],
    declaration: {
      nodes: nodes.slice(0, 8).map(node => ({ id: node.nodeId, agent: node.agent })),
      edges: [],
    },
  },
};
const status = {
  ok: true,
  engineGraphs: [graph, { ...graph, graphId: "second-graph" }],
  sessions: {
    count: 24,
    mostRecentId: sessionId,
    activeRoles: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [
      i === 0 ? sessionId : `session-${i}-${longText}`, longText,
    ])),
  },
  loops: {
    count: 1,
    states: [{
      originSessionId: sessionId,
      agent: longText,
      phase: "error",
      mode: longText,
      current: 123456789,
      total: 1234567890,
      activeWorkerSessionId: sessionId,
      activeWorkerTaskId: longText,
      parentLoopId: longText,
      errorReason: longText,
    }],
  },
};
const metrics = {
  counters: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [
    `counter_${i}_${longText}{agent=${longText}}`, { value: 123456789012345 },
  ])),
  gauges: { [longText]: { value: 1e100 } },
  histograms: {
    [`duration_${longText}{agent=${longText}}`]: {
      count: 150,
      sum: 11325,
      buckets: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [i + 1, i + 1])),
    },
  },
};

describe.skipIf(!live)("DSH monitor browser layout", () => {
  let browser: Browser;
  let script: string;
  let hostCss: string;
  let prefix: string;

  beforeAll(async () => {
    const host = readFileSync(resolve(root, "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"), "utf8");
    const cssModule = host.slice(host.indexOf("ConversationRoot.module.css"));
    const cssLiteral = /const css\$\d+ = ("(?:[^"\\]|\\.)*");/.exec(cssModule)?.[1];
    if (!cssLiteral) throw new Error("Conversation stylesheet not found");
    hostCss = JSON.parse(cssLiteral) as string;
    prefix = /\.([\w]+)_root\{/.exec(hostCss)![1]!;
    const result = await build({
      stdin: {
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { RoleboxMonitorPanel } from './src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.tsx';
          window.EventSource = undefined;
          window.fetch = async url => {
            const fixture = window.fixture;
            if (fixture.loading) return new Promise(() => {});
            const data = String(url).startsWith('/rolebox/status') ? fixture.status : fixture.metrics;
            return new Response(JSON.stringify(data), {status: fixture.error ? 500 : 200});
          };
          createRoot(document.getElementById('panel')).render(<RoleboxMonitorPanel sessionId=${JSON.stringify(sessionId)} />);
        `,
        loader: "tsx",
        resolveDir: root,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    script = result.outputFiles[0]!.text;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => { await browser?.close(); });

  async function mount(page: Page, scenario = "full", width?: number) {
    const fixture = {
      status: scenario === "empty" ? { ok: true } : scenario === "sparse"
        ? { ...status, engineGraphs: [{ ...graph, graph: undefined, nodes: Array.from({ length: 160 }, (_, i) => ({ ...nodes[0], nodeId: `node-${i}`, status: "pending" })) }] }
        : status,
      metrics: scenario === "empty" ? {} : metrics,
      error: scenario === "error",
      loading: scenario === "loading",
    };
    await page.setContent(`<!doctype html><html><meta charset="utf-8"><style>
      ${hostCss}
      :root { --dsw-font-xs-13: 13px/20px system-ui; --dsw-font-s-strong-14: 600 14px/22px system-ui; --dsw-alias-bg-base: white; }
      body { margin: 0; font: 13px/20px system-ui; }
      .shell { height: 100vh; width: ${width ? `${width}px` : "100%"}; margin: auto; }
      #panel { display: contents; }
      footer { flex: none; padding: 20px; background: white; }
    </style><div class="shell ${prefix}_root" data-phase="active">
      <div class="${prefix}_body"><div class="${prefix}_scrollBody" data-conversation-scroll>
        <div class="${prefix}_viewArea"><div id="panel"></div></div>
        <footer class="${prefix}_composerSeat">Composer</footer>
      </div></div></div></html>`);
    await page.evaluate(data => { Object.assign(window, { fixture: data }); }, fixture);
    await page.addScriptTag({ content: script });
    await page.locator(`[data-rolebox-monitor][aria-busy="${scenario === "loading"}"]`).waitFor();
  }

  async function overflow(page: Page) {
    return page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".rolebox-monitor")!;
      const content = document.querySelector<HTMLElement>(".rolebox-monitor-panel")!;
      const bounds = content.getBoundingClientRect();
      const problems: string[] = [];
      for (const element of content.querySelectorAll<HTMLElement>("*")) {
        if (!(element instanceof HTMLElement) || element.closest(".rolebox-monitor-sr, .rolebox-monitor-graph-canvas, pre")) continue;
        const r = element.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const clipped = !(element instanceof HTMLSelectElement) && element.scrollWidth > element.clientWidth + 1;
        if (r.left < bounds.left - 1 || r.right > bounds.right + 1 || clipped) problems.push(element.className || element.tagName);
      }
      const style = getComputedStyle(panel);
      return {
        problems: [...new Set(problems)],
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        unusedWidth: panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - bounds.width,
        unusedHostWidth: document.querySelector<HTMLElement>("[data-conversation-scroll]")!.clientWidth - panel.getBoundingClientRect().width,
      };
    });
  }

  it("forwards vertical wheel input from the ledger, topology and native details to the Conversation", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await mount(page);
      const host = page.locator("[data-conversation-scroll]");
      for (const selector of [".rolebox-monitor-header", ".rolebox-monitor-graph-canvas", ".rolebox-monitor-graph pre", ".rolebox-monitor-session-row", ".rolebox-monitor-loop", ".rolebox-monitor-metric-row"]) {
        if (selector.endsWith("pre")) await page.locator("details").evaluate(e => { e.setAttribute("open", ""); });
        const target = page.locator(selector).first();
        await target.scrollIntoViewIfNeeded();
        const before = await host.evaluate(e => e.scrollTop);
        await target.hover();
        await page.mouse.wheel(0, before > 0 ? -120 : 120);
        await expect.poll(() => host.evaluate(e => e.scrollTop), { timeout: 1500 }).not.toBe(before);
      }
      expect(await page.locator(".rolebox-monitor").evaluate(e => e.scrollTop)).toBe(0);
    } finally { await page.close(); }
  });

  it("supports keyboard page scrolling in a short window", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 320 } });
    try {
      await mount(page);
      await page.getByRole("button", { name: "Refresh", exact: true }).focus();
      await page.keyboard.press("PageDown");
      await expect.poll(() => page.locator("[data-conversation-scroll]").evaluate(e => e.scrollTop)).toBeGreaterThan(0);
    } finally { await page.close(); }
  });

  it("keeps horizontal wheel input local to wide figures and native records", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
    try {
      await mount(page);
      await page.locator("details").evaluate(e => { e.setAttribute("open", ""); });
      for (const selector of [".rolebox-monitor-graph-canvas", ".rolebox-monitor-graph pre"]) {
        const target = page.locator(selector);
        await target.scrollIntoViewIfNeeded();
        await target.hover();
        await page.mouse.wheel(240, 0);
        await expect.poll(() => target.evaluate(e => e.scrollLeft)).toBeGreaterThan(0);
      }
    } finally { await page.close(); }
  });

  for (const width of [280, 320, 390, 768, 1280, 1920, 2560]) {
    it(`fits every section and expanded rows at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await mount(page);
        for (const button of await page.getByRole("button", { name: /^Show .* more/ }).all()) await button.click();
        await page.locator("details").evaluate(e => { e.setAttribute("open", ""); });
        expect(await overflow(page)).toEqual({ problems: [], documentOverflow: false, unusedWidth: 0, unusedHostWidth: 0 });
        expect(await page.locator(".rolebox-monitor-session-id").first().textContent()).toBe(sessionId);
        expect(await page.locator(".rolebox-monitor-graph-id").textContent()).toBe(longText);
        expect(await page.getByLabel("Graph", { exact: true }).getAttribute("title")).toBe(longText);
        if (width <= 390) expect(await page.locator("pre").evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
      } finally { await page.close(); }
    });
  }

  for (const scenario of ["sparse", "empty", "error", "loading"]) {
    it(`fits the ${scenario} state in a narrow column of a wide window`, async () => {
      const page = await browser.newPage({ viewport: { width: 1920, height: 600 } });
      try {
        await mount(page, scenario, 280);
        expect(await overflow(page)).toEqual({ problems: [], documentOverflow: false, unusedWidth: 0, unusedHostWidth: 0 });
      } finally { await page.close(); }
    });
  }
});
