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
          import React, { useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SuggestDock } from './src/platform/adapters/dsh/web-ui/suggest-dock.tsx';
          import { zh } from './src/platform/adapters/dsh/web-ui/suggest-locales.ts';
          window.calls = [];
          window.responders = [];
          window.gated = false;
          window.submissions = [];
          window.responseMode = 'suggested';
          window.suggestionText = '补充取消场景的测试';
          window.fetch = async (_url, options) => {
            window.calls.push({ ...JSON.parse(options.body), signal: options.signal });
            const response = () => new Response(JSON.stringify({ ok: true, status: window.responseMode, text: window.suggestionText }));
            if (window.gated) return new Promise(resolve => window.responders.push(() => resolve(response())));
            return response();
          };
          function Fixture() {
            const [running, setRunning] = useState(true);
            const [sessionId, setSession] = useState('session-1');
            const [input, setInput] = useState({ draft: '', phase: 'plain', attachmentIds: [], draftRev: 0 });
            const inputRef = useRef(input);
            const updateInput = patch => {
              inputRef.current = { ...inputRef.current, ...patch };
              setInput(inputRef.current);
            };
            window.setRunning = setRunning;
            window.setSession = setSession;
            window.updateInput = updateInput;
            return <SuggestDock sessionId={sessionId}
              useSession={selector => selector({ running, blank: false, subagent: null })}
              useInput={selector => selector(input)}
              inputActions={{
                setDraft(text) { updateInput({ draft: text, draftRev: inputRef.current.draftRev + 1 }); },
                submit() {
                  window.submissions.push(inputRef.current.draft);
                  updateInput({ draft: '', phase: 'submitting' });
                },
              }} t={key => zh[key] ?? key} />;
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
      const modes = page.getByRole("combobox", { name: "Copilot 模式" });
      await pill.hover();
      await modes.waitFor({ state: "visible" });
      const pillBox = (await pill.boundingBox())!;
      await page.mouse.move(pillBox.x + pillBox.width / 2, pillBox.y - 4);
      expect(await modes.isVisible()).toBe(true);
      await modes.selectOption("manual");
      expect(await modes.inputValue()).toBe("manual");

      await page.reload();
      await page.addScriptTag({ content: script });
      await pill.waitFor();
      await pill.hover();
      expect(await modes.inputValue()).toBe("manual");
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

  it("shows only mode settings on hover and closes them when requesting a suggestion", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const pill = page.locator(".rolebox-suggest-button");
      const settings = page.locator(".rolebox-suggest-tip");
      await pill.hover();
      await settings.waitFor({ state: "visible" });
      expect(await settings.textContent()).not.toContain("让配置的快模型");
      expect(await settings.textContent()).not.toContain("建议下一条消息");
      expect(await settings.getByRole("combobox", { name: "Copilot 模式" }).isVisible()).toBe(true);
      await page.evaluate(() => {
        const fixture = window as unknown as { gated: boolean; setRunning(value: boolean): void };
        fixture.gated = true;
        fixture.setRunning(false);
      });
      await pill.click();
      await settings.waitFor({ state: "hidden" });
      expect(await page.locator(".rolebox-suggest-card").count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("keeps an existing card mounted while regenerating and replaces its text when ready", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      await page.evaluate(() => (window as unknown as { setRunning(value: boolean): void }).setRunning(false));
      const card = page.locator(".rolebox-suggest-card");
      await card.waitFor();
      await page.evaluate(() => {
        const fixture = window as unknown as { gated: boolean; oldCard: Element | null };
        fixture.gated = true;
        fixture.oldCard = document.querySelector(".rolebox-suggest-card");
      });
      await page.locator(".rolebox-suggest-button").click();
      expect(await card.isVisible()).toBe(true);
      expect(await card.textContent()).toContain("补充取消场景的测试");
      expect(await card.getAttribute("aria-busy")).toBe("true");
      await page.evaluate(() => {
        const fixture = window as unknown as { suggestionText: string; responders: (() => void)[] };
        fixture.suggestionText = "验证修改后的交互";
        fixture.responders[0]!();
      });
      await expect.poll(() => card.textContent()).toContain("验证修改后的交互");
      expect(await page.evaluate(() => document.querySelector(".rolebox-suggest-card") === (window as unknown as { oldCard: Element }).oldCard)).toBe(true);
      expect(await page.locator(".rolebox-suggest-tip").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });

  it.each(["填入", "忽略"])("closes directly after %s without flashing the hover settings", async (action) => {
    const page = await browser.newPage();
    try {
      await mount(page);
      await page.evaluate(() => (window as unknown as { setRunning(value: boolean): void }).setRunning(false));
      const card = page.locator(".rolebox-suggest-card");
      await card.waitFor();
      await page.evaluate(() => {
        const fixture = window as unknown as { settingsFrames: boolean[]; sampling: Promise<void> };
        fixture.settingsFrames = [];
        fixture.sampling = new Promise(resolve => {
          let frames = 0;
          const sample = () => {
            const panel = document.querySelector(".rolebox-suggest-tip")!;
            const style = getComputedStyle(panel);
            fixture.settingsFrames.push(style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0);
            if (++frames < 30) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
      });
      await card.getByRole("button", { name: action, exact: true }).click();
      await card.waitFor({ state: "hidden" });
      await page.evaluate(() => (window as unknown as { sampling: Promise<void> }).sampling);
      expect(await page.evaluate(() => (window as unknown as { settingsFrames: boolean[] }).settingsFrames.some(Boolean))).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("uses opaque surfaces in both light and dark themes even when the host menu is translucent", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      for (const color of ["rgb(255, 255, 255)", "rgb(28, 29, 33)"]) {
        await page.evaluate((base) => {
          document.documentElement.style.setProperty("--dsw-alias-bg-base", base);
          document.documentElement.style.setProperty("--dsw-specific-menu", "rgba(100, 100, 100, 0.5)");
        }, color);
        await page.locator(".rolebox-suggest-button").hover();
        const settings = page.locator(".rolebox-suggest-tip");
        await settings.waitFor({ state: "visible" });
        expect(await settings.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(color);
        expect(await settings.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
      }
      await page.evaluate(() => (window as unknown as { setRunning(value: boolean): void }).setRunning(false));
      const card = page.locator(".rolebox-suggest-card");
      await card.waitFor();
      expect(await card.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(28, 29, 33)");
    } finally {
      await page.close();
    }
  });

  it("shows a manual miss separately and reopens settings only after a fresh hover", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const pill = page.locator(".rolebox-suggest-button");
      const settings = page.locator(".rolebox-suggest-tip");
      await pill.hover();
      await settings.getByRole("combobox").selectOption("manual");
      await page.evaluate(() => {
        const fixture = window as unknown as { responseMode: string; setRunning(value: boolean): void };
        fixture.responseMode = "none";
        fixture.setRunning(false);
      });
      await pill.click();
      const notice = page.getByRole("status");
      await notice.waitFor();
      expect(await notice.textContent()).toContain("暂时没有合适的建议");
      expect(await settings.isVisible()).toBe(false);
      await page.keyboard.press("Escape");
      await notice.waitFor({ state: "hidden" });
      expect(await settings.isVisible()).toBe(false);
      await page.mouse.move(0, 0);
      await pill.hover();
      await settings.waitFor({ state: "visible" });
      expect(await settings.textContent()).not.toContain("暂时没有合适的建议");
    } finally {
      await page.close();
    }
  });

  it("keeps keyboard focus through mode changes and Escape without controls inside a tooltip", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const pill = page.locator(".rolebox-suggest-button");
      const modes = page.getByRole("combobox", { name: "Copilot 模式" });
      await pill.focus();
      await modes.waitFor({ state: "visible" });
      await page.keyboard.press("Tab");
      expect(await modes.evaluate(element => element === document.activeElement)).toBe(true);
      await modes.selectOption("manual");
      expect(await modes.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await page.locator('[role="tooltip"] :is(button, select)').count()).toBe(0);
      await page.keyboard.press("Escape");
      await modes.waitFor({ state: "hidden" });
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
      const modes = page.getByRole("combobox", { name: "Copilot 模式" });
      await modes.selectOption("manual");
      expect(await page.evaluate(() => (window as unknown as { calls: { signal: AbortSignal }[] }).calls[0]!.signal.aborted)).toBe(true);

      const pill = page.locator(".rolebox-suggest-button");
      await pill.click();
      await page.waitForFunction(() => (window as unknown as { calls: unknown[] }).calls.length === 2);
      await page.evaluate(() => (window as unknown as { responders: (() => void)[] }).responders[0]!());
      expect(await pill.getAttribute("data-state")).toBe("loading");
      expect(await page.locator(".rolebox-suggest-card").count()).toBe(0);
      await page.evaluate(() => (window as unknown as { responders: (() => void)[] }).responders[1]!());
      await page.locator(".rolebox-suggest-card").waitFor();
      expect(await page.getByRole("combobox", { name: "Copilot 模式" }).count()).toBe(0);
      expect(await page.locator(".rolebox-suggest-tip").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });

  it.each(["auto", "manual"])("shows only the %s suggestion and actions until the card is dismissed", async (intent) => {
    const page = await browser.newPage();
    try {
      await mount(page);
      await page.evaluate(() => (window as unknown as { setRunning(value: boolean): void }).setRunning(false));
      const pill = page.locator(".rolebox-suggest-button");
      if (intent === "manual") await pill.click();
      const card = page.locator(".rolebox-suggest-card");
      await card.waitFor();
      expect(await card.locator("select").count()).toBe(0);
      expect(await card.textContent()).not.toContain("Copilot 模式");
      expect(await card.getByRole("button").allTextContents()).toEqual(["填入", "忽略"]);
      await pill.hover();
      expect(await page.locator(".rolebox-suggest-tip").isVisible()).toBe(false);
      await card.getByRole("button", { name: "忽略", exact: true }).focus();
      expect(await page.getByRole("combobox").count()).toBe(0);
      await page.keyboard.press("Enter");
      await card.waitFor({ state: "hidden" });
      expect(await page.locator(".rolebox-suggest-tip").isVisible()).toBe(false);
      await page.mouse.move(0, 0);
      await pill.hover();
      const modes = page.getByRole("combobox", { name: "Copilot 模式" });
      await modes.waitFor({ state: "visible" });
      await modes.focus();
      await modes.selectOption("manual");
      expect(await modes.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await modes.inputValue()).toBe("manual");
    } finally {
      await page.close();
    }
  });

  it("submits once in full automation and keeps settings reachable when switched off", async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const pill = page.locator(".rolebox-suggest-button");
      await pill.hover();
      const modes = page.getByRole("combobox", { name: "Copilot 模式" });
      await modes.selectOption("auto-mated");
      await expect.poll(() => pill.textContent()).toBe("自动接续");
      await page.evaluate(() => (window as unknown as { setRunning(value: boolean): void }).setRunning(false));
      await page.waitForFunction(() => (window as unknown as { submissions: string[] }).submissions.length === 1);
      expect(await page.evaluate(() => (window as unknown as { submissions: string[] }).submissions)).toEqual(["补充取消场景的测试"]);
      expect(await page.locator(".rolebox-suggest-card").count()).toBe(0);

      await page.locator("[data-rolebox-suggest]").hover();
      await modes.selectOption("none");
      expect(await pill.isDisabled()).toBe(true);
      await page.locator("[data-rolebox-suggest]").focus();
      await page.keyboard.press("Tab");
      expect(await modes.evaluate(element => element === document.activeElement)).toBe(true);
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => (window as unknown as { submissions: string[] }).submissions.length)).toBe(1);
    } finally {
      await page.close();
    }
  });
});
