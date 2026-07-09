import { bold, dim, red, green, cyan, yellow, border, white, stripAnsi } from "../../format.ts";
import type { MonitorSnapshot, TaskSnapshot } from "../monitor-reader.ts";
import { formatDuration, truncate, statusGlyph, statusColor, statusCell, contentWidth, isNarrow } from "../monitor-helpers.ts";

// ── Layout helper ──────────────────────────────────────────────────

/**
 * Unified panel renderer — wraps content in a straight box-drawing
 * border with the title embedded in the top border.
 * In narrow mode, renders as a plain title + rule instead.
 */
export function panel(title: string, lines: string[]): void {
  const w = contentWidth();
  const narrow = isNarrow();

  if (narrow) {
    console.log("");
    console.log(`  ${bold(cyan(title))}`);
    console.log(`  ${border("\u2500".repeat(Math.min(w, 50)))}`);
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    return;
  }

  // ── Normal (wide) panel ──
  const titlePart = bold(cyan(title));
  const titleWidth = stripAnsi(titlePart).length;
  const fillLen = Math.max(1, w - 4 - titleWidth); // "┌ " + title + " ──... ┐"
  const borderTop = `  ${border("\u250c ")}${titlePart} ${border("\u2500".repeat(fillLen))}${border("\u2510")}`;
  console.log(borderTop);

  const innerWidth = w - 4; // 2 border chars each side
  for (const line of lines) {
    const trimmed = line.replace(/^  /, "");
    const content = stripAnsi(trimmed).length > innerWidth ? truncate(trimmed, innerWidth) : trimmed;
    const padLen = Math.max(0, innerWidth - stripAnsi(content).length);
    console.log(`  ${border("\u2502 ")}${content}${" ".repeat(padLen)}${border(" \u2502")}`);
  }

  const borderBottom = `  ${border("\u2514")}${border("\u2500".repeat(w - 2))}${border("\u2518")}`;
  console.log(borderBottom);
}

// ── Filtering & Sorting ────────────────────────────────────────────

export function filterAndSortTasks(
  tasks: TaskSnapshot[],
  all: boolean,
  agentFilter?: string,
  statusFilter?: string,
  sortField?: string,
): TaskSnapshot[] {
  let visible = all
    ? tasks
    : tasks.filter((t) => ["running", "pending", "error"].includes(t.status));

  if (agentFilter && agentFilter.length > 0) {
    const pattern = agentFilter.toLowerCase();
    visible = visible.filter((t) => t.agent.toLowerCase().includes(pattern));
  }

  if (statusFilter && statusFilter.length > 0) {
    const statuses = statusFilter.split(",").map((s) => s.trim().toLowerCase());
    visible = visible.filter((t) => statuses.includes(t.status));
  }

  if (sortField) {
    switch (sortField) {
      case "status": {
        const statusOrder: Record<string, number> = {
          running: 0,
          pending: 1,
          error: 2,
          completed: 3,
          timeout: 4,
          cancelled: 5,
        };
        visible = [...visible].sort(
          (a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99),
        );
        break;
      }
      case "agent":
        visible = [...visible].sort((a, b) => a.agent.localeCompare(b.agent));
        break;
      case "duration":
        visible = [...visible].sort((a, b) => b.durationMs - a.durationMs);
        break;
      case "started":
        visible = [...visible].sort(
          (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
        );
        break;
      default:
        break;
    }
  }

  return visible;
}

// ── Render: Tasks + Concurrency ────────────────────────────────────

export function renderTasks(
  snapshot: MonitorSnapshot,
  all: boolean,
  tailChars: number,
  agentFilter?: string,
  statusFilter?: string,
  sortField?: string,
): void {
  const visible = filterAndSortTasks(snapshot.tasks, all, agentFilter, statusFilter, sortField);
  const concur = snapshot.concurrency;
  const w = contentWidth();
  const narrow = isNarrow();
  const lines: string[] = [];

  const hasActiveFilters = (agentFilter && agentFilter.length > 0) || (statusFilter && statusFilter.length > 0);

  if (visible.length === 0) {
    let emptyMsg: string;
    if (hasActiveFilters) {
      emptyMsg = dim("\u25cb no tasks match filters");
    } else if (snapshot.tasks.length === 0) {
      emptyMsg = dim("\u25cb no dispatch activity");
    } else {
      emptyMsg = dim("\u25cb all tasks completed. use --all to show");
    }
    lines.push(`  ${emptyMsg}`);
    panel("Tasks", lines);
    return;
  }

  if (narrow) {
    // Narrow mode: simple list
    for (const t of visible) {
      const icon = statusGlyph(t.status);
      const color = statusColor(t.status);
      const statusPart = color(`${icon} ${t.status}`);
      const descPart = (t.description || "").slice(0, 40);
      lines.push(`  ${statusPart}  ${bold(truncate(t.agent, 20))}  ${descPart}`);
      if (t.error) {
        const errMsg = t.error.startsWith("Error:") ? t.error.slice(6).trim() : t.error;
        lines.push(`    ${border("\u2514\u2500")} ${red(errMsg)}`);
      }
      if (tailChars > 0 && t.resultPreview) {
        const previewLines = t.resultPreview.split("\n").slice(0, 3);
        for (const pl of previewLines) {
          lines.push(`    ${border("\u2502")} ${dim(pl)}`);
        }
      }
    }
  } else {
    // Default sort by urgency: running → pending → error → completed → cancelled → timeout
    const urgencyOrder: Record<string, number> = {
      running: 0,
      pending: 1,
      error: 2,
      completed: 3,
      cancelled: 4,
      timeout: 5,
    };
    const sorted = [...visible].sort(
      (a, b) => (urgencyOrder[a.status] ?? 99) - (urgencyOrder[b.status] ?? 99),
    );

    // Fixed-width columns
    const agentW = 20;
    // Description: flex, truncated to fit. Content width minus fixed columns.
    const statusW = 11; // glyph + space + status word, padded
    const durW = 8; // right-aligned
    const fixedW = statusW + 1 + agentW + 1 + durW + 1; // +1 for spacing
    const descW = Math.max(10, Math.min(50, w - 4 - fixedW)); // contentWidth - panel padding - fixed

    for (const t of sorted) {
      const sc = statusCell(t.status);
      const agentPart = bold(truncate(t.agent, agentW).padEnd(agentW));
      const descPart = truncate((t.description || ""), descW).padEnd(descW);
      const durPart = t.status === "pending" ? dim("\u2014".padStart(durW)) : dim(formatDuration(t.durationMs).padStart(durW));
      lines.push(`  ${sc} ${agentPart} ${descPart} ${durPart}`);

      if (t.error) {
        const errMsg = t.error.startsWith("Error:") ? t.error.slice(6).trim() : t.error;
        lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2514\u2500")} ${red(errMsg)}`);
      }

      if (tailChars > 0 && t.resultPreview) {
        const totalChars = t.resultTotalChars ?? t.resultPreview.length;
        const charsLabel = dim(` [${t.resultPreview.length}/${totalChars} chars]`);
        lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2564\u2500 output")}${charsLabel}`);
        const previewLines = t.resultPreview.split("\n");
        for (const pl of previewLines) {
          lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2502")} ${pl}`);
        }
        lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2570\u2500")}`);
      }
    }
  }

  // Concurrency inline (1 line under tasks)
  const shouldShowConcurrency = !(concur.limit === 0 && concur.active === 0 && concur.queued === 0);
  if (shouldShowConcurrency) {
    const activePart = `${cyan(String(concur.active))}${dim("/")}${white(String(concur.limit))}`;
    const queuedPart = concur.queued > 0 ? ` ${yellow("+" + String(concur.queued))} ${dim("queued")}` : "";
    lines.push(`  ${dim("slots")} ${activePart}${queuedPart}`);
  }

  panel("Tasks", lines);
}

export function computeHealthState(snapshot: MonitorSnapshot): { state: string; color: (s: string) => string } {
  const ds = snapshot.dispatchSummary;
  const hasError = ds.error > 0 || snapshot.loops.some((l) => l.phase === "error") || snapshot.tasks.some((t) => t.status === "error");
  if (hasError) return { state: "ERROR", color: red };

  const hasActive = ds.running > 0 || ds.pending > 0 || snapshot.loops.length > 0 || snapshot.activeFunctions.length > 0 || snapshot.graphSessions.some((g) => g.status === "active");
  if (hasActive) return { state: "ACTIVE", color: green };

  return { state: "IDLE", color: yellow };
}
