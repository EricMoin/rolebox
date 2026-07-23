/**
 * PiRoleSwitcher — in-session "switch active role" capability for the Pi platform.
 *
 * Pi is a minimal single-agent harness with no built-in agent picker. rolebox
 * already resolves every role into an {@link AgentDefinition} (id, name,
 * description, systemPrompt, model) and registers them on the
 * {@link PiAgentRegistrar}. This module turns that registry into an
 * opencode-style role switcher, implemented purely through Pi's extension API:
 *
 *   - `/role [name]`      — pick a primary role via arg or interactive selector
 *   - `/role none|off`    — clear the active role (back to the base agent)
 *   - `Ctrl+Shift+R`      — cycle to the next primary role
 *
 * Switching a role does three things:
 *   1. `pi.setModel()`               — adopt the role's model (alias already resolved)
 *   2. `before_agent_start` injection — append the role's system prompt each turn
 *   3. `pi.appendEntry()` + restore   — persist the choice across `/resume`
 *
 * This lives in the Pi adapter only. opencode has its own native agent picker
 * and is unaffected. Gated by `PlatformCapabilities.hasRoleSwitch`.
 *
 * `pi` is loosely typed (`any`) because it is an optional peer dependency, matching
 * the convention in `pi-extension.ts`.
 *
 * @module
 */

import { RoleMode } from "../../../constants.ts";
import { createSubLogger, formatError } from "../../../logger.ts";
import type { AgentDefinition } from "../../types.ts";
import type { PiAgentRegistrar } from "./agent-registrar.ts";
import type { ActiveAgentRef } from "./active-agent.ts";
import { createActiveAgentRef } from "./active-agent.ts";

/** Session entry customType used to persist the active role selection. */
const ACTIVE_ROLE_ENTRY = "rolebox-active-role";

/** Status bar / widget key used for the active-role indicator. */
const STATUS_KEY = "rolebox-role";

/** Default shortcut for cycling through primary roles. */
const CYCLE_SHORTCUT = "ctrl+shift+r";

/**
 * Options for {@link wireRoleSwitcher}.
 */
export interface RoleSwitcherOptions {
  /** Pi ExtensionAPI instance (loosely typed optional peer dependency). */
  pi: any;
  /** Registry holding all resolved agent definitions (roles + subagents). */
  registrar: PiAgentRegistrar;
  /** Keybinding for cycling roles. Defaults to {@link CYCLE_SHORTCUT}. */
  cycleShortcut?: string;
  /**
   * Shared active-agent ref bridging the switched role into the dispatch
   * tool's "direct child" gate. When omitted, a private ref is created (the
   * switcher still works, but dispatch scoping is not shared).
   */
  activeAgent?: ActiveAgentRef;
}

/**
 * Parse a resolved model string into a `{ provider, id }` pair.
 *
 * rolebox stores fully-resolved models (aliases already applied) as
 * `"<provider>/<model-id>"`, where the model id itself may contain slashes
 * (e.g. `"hfai-anthropic/anthropic/claude-opus-4.8"`). The provider is the
 * segment before the first slash; everything after is the model id.
 *
 * @param model - Resolved model string, or undefined.
 * @returns The split pair, or null when the model is empty/`"default"`/malformed.
 */
function splitModel(model: string | undefined): { provider: string; id: string } | null {
  if (!model || model === "default") return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) return null;
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/**
 * Wire the role switcher into a Pi extension runtime.
 *
 * Registers the `/role` command, the cycle shortcut, the per-turn system-prompt
 * injection hook, and cross-session restore. All handlers are defensively
 * guarded so a missing/limited Pi API (e.g. print or JSON mode) degrades
 * gracefully instead of throwing into the Pi runtime.
 *
 * @param options - See {@link RoleSwitcherOptions}.
 */
export function wireRoleSwitcher(options: RoleSwitcherOptions): void {
  const { pi, registrar } = options;
  const cycleShortcut = options.cycleShortcut ?? CYCLE_SHORTCUT;
  const activeAgent = options.activeAgent ?? createActiveAgentRef();
  const log = createSubLogger("pi-role-switcher");

  if (typeof pi?.on !== "function") {
    log.debug("Pi API lacks .on() — role switcher not wired");
    return;
  }

  /** List primary (top-level) roles — the only switchable targets. */
  function primaryRoles(): AgentDefinition[] {
    return registrar
      .getRegisteredAgents()
      .filter((a) => (a.mode ?? RoleMode.Primary) === RoleMode.Primary)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Look up a primary role by exact id, then by case-insensitive name. */
  function findRole(query: string): AgentDefinition | undefined {
    const roles = primaryRoles();
    const q = query.trim();
    return (
      roles.find((r) => r.id === q) ??
      roles.find((r) => r.name.toLowerCase() === q.toLowerCase())
    );
  }

  /** Update the footer status indicator, if the UI supports it. */
  function setStatus(ctx: any, label: string | null): void {
    try {
      if (ctx?.hasUI && typeof ctx.ui?.setStatus === "function") {
        ctx.ui.setStatus(STATUS_KEY, label ?? "");
      }
    } catch (err) {
      log.debug("setStatus failed", { error: formatError(err) });
    }
  }

  /** Attempt to switch the active model to the role's model. */
  async function applyModel(ctx: any, role: AgentDefinition): Promise<void> {
    const parsed = splitModel(role.model);
    if (!parsed) return;
    try {
      const model = ctx?.modelRegistry?.find?.(parsed.provider, parsed.id);
      if (model && typeof pi.setModel === "function") {
        const ok = await pi.setModel(model);
        if (!ok) {
          log.debug("setModel returned false", { role: role.id, model: role.model });
        }
      } else {
        log.debug("Model not found in registry — keeping current model", {
          role: role.id,
          model: role.model,
        });
      }
    } catch (err) {
      log.debug("applyModel failed", { role: role.id, error: formatError(err) });
    }
  }

  /** Persist the active-role selection into the session for cross-resume restore. */
  function persist(id: string | null): void {
    try {
      if (typeof pi.appendEntry === "function") {
        pi.appendEntry(ACTIVE_ROLE_ENTRY, { id });
      }
    } catch (err) {
      log.debug("persist failed", { error: formatError(err) });
    }
  }

  /**
   * Activate a role by id (or clear when id is null). Sets model, status, and
   * persists. The system prompt itself is applied lazily in before_agent_start.
   */
  async function activate(
    ctx: any,
    id: string | null,
    opts: { persist?: boolean; announce?: boolean } = {},
  ): Promise<void> {
    const doPersist = opts.persist ?? true;
    const announce = opts.announce ?? true;

    if (id === null) {
      activeAgent.set(null);
      setStatus(ctx, null);
      if (doPersist) persist(null);
      if (announce && ctx?.hasUI) ctx.ui?.notify?.("Role cleared — using base agent", "info");
      return;
    }

    const role = registrar.getRegisteredAgents().find((a) => a.id === id);
    if (!role) {
      if (announce && ctx?.hasUI) ctx.ui?.notify?.(`Unknown role: ${id}`, "warn");
      return;
    }

    activeAgent.set(role.id);
    await applyModel(ctx, role);
    setStatus(ctx, `role: ${role.name}`);
    if (doPersist) persist(role.id);
    if (announce && ctx?.hasUI) {
      ctx.ui?.notify?.(`Switched to ${role.name} (${role.id})`, "info");
    }
    log.info("Active role switched", { role: role.id, model: role.model });
  }

  // ── /role command ─────────────────────────────────────────────────────

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("role", {
      description: "Switch the active rolebox role (arg, selector, or 'none' to clear)",
      handler: async (args: string, ctx: any) => {
        const arg = (args ?? "").trim();

        if (arg === "none" || arg === "off" || arg === "clear") {
          await activate(ctx, null);
          return;
        }

        if (arg) {
          const role = findRole(arg);
          if (!role) {
            ctx?.ui?.notify?.(`Unknown role: ${arg}`, "warn");
            return;
          }
          await activate(ctx, role.id);
          return;
        }

        // No arg — interactive selector.
        const roles = primaryRoles();
        if (roles.length === 0) {
          ctx?.ui?.notify?.("No roles available", "warn");
          return;
        }
        if (!ctx?.hasUI || typeof ctx.ui?.select !== "function") {
          ctx?.ui?.notify?.(
            `Available roles: ${roles.map((r) => r.id).join(", ")}`,
            "info",
          );
          return;
        }

        const labels = roles.map((r) => `${r.name} (${r.id}) — ${r.description}`);
        const choice = await ctx.ui.select("Switch to role:", [
          ...labels,
          "· clear active role ·",
        ]);
        if (!choice) return;
        const idx = labels.indexOf(choice);
        if (idx === -1) {
          await activate(ctx, null);
          return;
        }
        await activate(ctx, roles[idx].id);
      },
    });
    log.debug("/role command registered");
  }

  // ── Ctrl+Shift+R cycle shortcut ─────────────────────────────────────────

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut(cycleShortcut, {
      description: "Cycle to the next rolebox role",
      handler: async (ctx: any) => {
        const roles = primaryRoles();
        if (roles.length === 0) return;
        const current = activeAgent.get()
          ? roles.findIndex((r) => r.id === activeAgent.get())
          : -1;
        const next = roles[(current + 1) % roles.length];
        await activate(ctx, next.id);
      },
    });
    log.debug("Role cycle shortcut registered", { shortcut: cycleShortcut });
  }

  // ── Per-turn system prompt injection ────────────────────────────────────

  pi.on("before_agent_start", async (event: any) => {
    const activeRoleId = activeAgent.get();
    if (!activeRoleId) return undefined;
    try {
      const role = registrar.getRegisteredAgents().find((a) => a.id === activeRoleId);
      if (!role) return undefined;
      const current = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
      return { systemPrompt: `${current}\n\n${role.systemPrompt}` };
    } catch (err) {
      log.debug("before_agent_start injection failed", { error: formatError(err) });
      return undefined;
    }
  });

  // ── Cross-session restore ───────────────────────────────────────────────

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const entries: any[] = ctx?.sessionManager?.getEntries?.() ?? [];
      // Find the most recent persisted active-role entry.
      let restoredId: string | null | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const type = e?.customType ?? e?.type;
        if (type === ACTIVE_ROLE_ENTRY) {
          restoredId = e?.data?.id ?? e?.id ?? null;
          break;
        }
      }
      if (restoredId === undefined) return;
      if (restoredId === null) {
        activeAgent.set(null);
        setStatus(ctx, null);
        return;
      }
      // Restore without re-persisting or re-announcing.
      await activate(ctx, restoredId, { persist: false, announce: false });
      log.info("Restored active role from session", { role: restoredId });
    } catch (err) {
      log.debug("session_start restore failed", { error: formatError(err) });
    }
  });

  log.info("Role switcher wired", {
    roles: primaryRoles().length,
    cycleShortcut,
  });
}
