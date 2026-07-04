// ── Notification System — Barrel Export ─────────────────────────────────
//
// Re-exports all public API surface of the notification subsystem.
// Grouped by source module for clarity.

// ── Types ───────────────────────────────────────────────────────────────
export * from "./types.ts";

// ── Config Parsing, Merging, Validation ─────────────────────────────────
export * from "./config.ts";

// ── Platform Detection & Command Resolution ─────────────────────────────
export * from "./platform.ts";

// ── Text Escaping, Script Builders, Truncation ──────────────────────────
export * from "./formatting.ts";

// ── Multi-Channel Dispatch (NotificationChannel, factory functions) ─────
export * from "./channels.ts";

// ── Template Rendering & Content Building ────────────────────────────────
export * from "./content.ts";

// ── Rate Limiting / Throttling ──────────────────────────────────────────
export * from "./throttle.ts";

// ── Quiet Hours (Do-Not-Disturb) ────────────────────────────────────────
export * from "./quiet-hours.ts";

// ── Idle Notification Scheduler ─────────────────────────────────────────
export * from "./scheduler.ts";

// ── Central Orchestrator (PRIMARY integration surface) ──────────────────
export * from "./manager.ts";

// ── Event System Integration Layer ──────────────────────────────────────
export * from "./hook.ts";
