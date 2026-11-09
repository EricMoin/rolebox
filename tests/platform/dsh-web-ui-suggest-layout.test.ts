import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const live = process.env.ROLEBOX_DSH_WEB_LAYOUT_LIVE === "1";

describe.skipIf(!live)("DSH suggestion hover settings in a browser", () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SuggestDock } from './src/platform/adapters/dsh/web-ui/suggest-dock.tsx';
          import { zh } from './src/platform/adapters/dsh/web-ui/suggest-locales.ts';
          window.calls = [];
          window.responders = [];
          window.gated = false;
          window.fetch = async (_url, options) => {
            window.calls.push({ ...JSON.parse(options.body), signal: options.signal });
            const response = () => new Response(JSON.stringify({ ok: true, status: 'suggested', text: '补充取消场景的测试' }));
            if (window.gated) return new Promise(resolve => window.responders.push(() => resolve(response())));
            return response();
          };
          function Fixture() {
            const [running, setRunning] = useState(true);
            const [sessionId, setSession] = useState('session-1');
            window.setRunning = setRunning;
            window.setSession = setSession;
            return <SuggestDock sessionId={sessionId}
              useSession={selector => selector({ running, blank: false, subagent: null })}
              useInput={selector => selector({ draft: '', phase: 'plain' })}
              inputActions={{ setDraft() {} }} t={key => zh[key] ?? key} />;
          }
          createRoot(document.getElementById('fixture')).render(<Fixture />);
        `,
        loader: "tsx",
        resolveDir: resolve(import.meta.dirname, "../.."),
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

  async function mount(page: Page): Promise<void> {
    await page.route("http://rolebox.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><meta charset="utf-8"><style>body { font: 13px system-ui; } #fixture { position: fixed; bottom: 48px; right: 48px; }</style><div id="fixture"></div></html>',
    }));
    await page.goto("http://rolebox.test/");
    await page.addScriptTag({ content: script });
    await page.locator("[data-rolebox-suggest]").waitFor();
  }

  it("keeps the panel open across the pointer gap and remembers opting out after a reload", async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    try {
      await mount(page);
      const pill = page.locator(".rolebox-suggest-button");
      const toggle = page.getByRole("switch", { name: "自动建议" });
      await pill.hover();
      await toggle.waitFor({ state: "visible" });
      const pillBox = (await pill.boundingBox())!;
      await page.mouse.move(pillBox.x + pillBox.width / 2, pillBox.y - 4);
      expect(await toggle.isVisible()).toBe(true);
      await toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");

      await page.reload();
      await page.addScriptTag({ content: script });
      await pill.waitFor();
      await pill.hover();
      expect(await toggle.getAttribute("aria-checked")).toBe("false");
      await page.evaluate(() => {
        const fixture = window as unknown as { setSession(id: string): void; setRunning(value: boolean): void };
        fixture.setSession("session-2");
        fixture.setRunning(false);
      });
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.length)).toBe(0);
      await pill.click();
      await page.locator(".rolebox-suggest-card").waitFor();
      expect(await page.evaluate(() => (window as unknown as { calls: { intent: string }[] }).calls.map(call => call.intent))).toEqual(["manual"]);
    } finally {
      await page.close();
    }
  });

  it("supports Tab, Space and Escape without placing controls inside a tooltip", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const pill = page.locator(".rolebox-suggest-button");
      const toggle = page.getByRole("switch", { name: "自动建议" });
      await pill.focus();
      await toggle.waitFor({ state: "visible" });
      await page.keyboard.press("Tab");
      expect(await toggle.evaluate(element => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Space");
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      expect(await page.locator('[role="tooltip"] button').count()).toBe(0);
      await page.keyboard.press("Escape");
      await toggle.waitFor({ state: "hidden" });
      expect(await pill.evaluate(element => element === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("lets a user stop automatic work while loading and still request a manual suggestion", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      await page.evaluate(() => {
        const fixture = window as unknown as { gated: boolean; setRunning(value: boolean): void };
        fixture.gated = true;
        fixture.setRunning(false);
      });
      await page.waitForFunction(() => (window as unknown as { calls: unknown[] }).calls.length === 1);
      await page.locator("[data-rolebox-suggest]").hover();
      const toggle = page.getByRole("switch", { name: "自动建议" });
      await toggle.click();
      expect(await page.evaluate(() => (window as unknown as { calls: { signal: AbortSignal }[] }).calls[0]!.signal.aborted)).toBe(true);

      const pill = page.locator(".rolebox-suggest-button");
      await pill.click();
      await page.waitForFunction(() => (window as unknown as { calls: unknown[] }).calls.length === 2);
      await page.evaluate(() => (window as unknown as { responders: (() => void)[] }).responders[0]!());
      expect(await pill.getAttribute("data-state")).toBe("loading");
      expect(await page.locator(".rolebox-suggest-card").count()).toBe(0);
      await page.evaluate(() => (window as unknown as { responders: (() => void)[] }).responders[1]!());
      await page.locator(".rolebox-suggest-card").waitFor();
      expect(await toggle.getAttribute("aria-checked")).toBe("false");
    } finally {
      await page.close();
    }
  });

  it("keeps keyboard access to settings when disabling a visible automatic card", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      await page.evaluate(() => (window as unknown as { setRunning(value: boolean): void }).setRunning(false));
      const card = page.locator(".rolebox-suggest-card");
      await card.waitFor();
      const toggle = page.getByRole("switch", { name: "自动建议" });
      await toggle.focus();
      await page.keyboard.press("Space");
      await card.waitFor({ state: "hidden" });
      const pill = page.locator(".rolebox-suggest-button");
      expect(await pill.evaluate(element => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await toggle.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await toggle.getAttribute("aria-checked")).toBe("false");
    } finally {
      await page.close();
    }
  });
});
