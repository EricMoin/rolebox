/**
 * Graph Execution Engine v2 — the acceptance capability set compile and run
 * share (P4 item 1)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * ONE SOURCE OF TRUTH. The capabilities a plan may pin are DERIVED from the
 * host-installed {@link ValidatorRegistry} — the same object the run path looks
 * an implementation up in at acceptance. There is no second capability list:
 * `graph_declare` cannot compile a plan naming a validator the host did not
 * install, because the set it compiles against IS the installed registry.
 *
 * WHAT A CALLER'S `supported_validators` ARGUMENT MAY DO. The model-facing
 * `graph_declare` still accepts the argument, and it is treated as a NARROWING
 * ASSERTION, never as an installation:
 *
 * - every declared entry must be substantiated by an installed registration —
 *   the same validator id at the same EXACT version (or, for an entry that
 *   names no version, exactly one installed version of that id, which it then
 *   pins). An entry the host cannot substantiate is REFUSED
 *   (`validator-capability-not-installed`), never compiled against;
 * - an entry that names no version while the host installs MORE than one
 *   version of that id is refused as ambiguous: picking one would make the
 *   pinned identity depend on registry order;
 * - entries are otherwise an intersection: the effective set is the declared
 *   subset, so a caller can only ever narrow what the host installed;
 * - with NO declaration the effective set is EVERY installed capability, so a
 *   declaration that simply omits the argument is resolved against the host's
 *   real capability set instead of compiling to a draft.
 *
 * WHY THE RUN SIDE IS THE SAME SET. At acceptance the core resolves each pinned
 * requirement through `ValidatorRegistry.lookup` and refuses
 * `validator-not-registered` when the implementation is absent. Because
 * compilation pins nothing but installed keys, a plan this build produced can
 * only carry requirements the SAME registry can substantiate; a host that later
 * removes a registration refuses the submission by name rather than skipping
 * the gate.
 */

import type { SupportedValidatorV3 } from "./compile.ts";
import {
  validatorKeyText,
  type ValidatorKey,
  type ValidatorRegistry,
} from "../outcome/validators.ts";

/**
 * Every installed validator capability, at its exact identity, in registration
 * order.
 *
 * The registry's keys ARE the capability set: each is an exact
 * `{ id, version }` with a real implementation behind it, which is why a
 * boolean declaration elsewhere can never add to this list.
 */
export function capabilitiesOfValidatorRegistry(
  registry: ValidatorRegistry,
): readonly SupportedValidatorV3[] {
  return Object.freeze(
    registry.keys.map((key) =>
      Object.freeze({ validator: key.id, version: key.version }),
    ),
  );
}

/** Why a caller's declared capability is not comparable with the installed set. */
export type DeclaredCapabilityIssueCode =
  /** The host installs no registration with this validator id. */
  | "validator-capability-not-installed"
  /** The host installs several versions and the declaration names none. */
  | "ambiguous-validator-version";

/** One declared entry the host cannot substantiate. */
export interface DeclaredCapabilityIssue {
  readonly code: DeclaredCapabilityIssueCode;
  /** The declared validator id, for diagnostics. */
  readonly validator: string;
  /** The declared version, when it named one. */
  readonly version?: number;
  /** Human-readable explanation. Wording is not part of the contract. */
  readonly message: string;
}

/** What a caller's declaration resolved to against the installed registry. */
export type DeclaredCapabilityResolution =
  | {
      readonly kind: "effective";
      /** The capabilities the compilation runs against. */
      readonly capabilities: readonly SupportedValidatorV3[];
    }
  | {
      readonly kind: "refused";
      /** Every entry that could not be substantiated, in declared order. */
      readonly issues: readonly DeclaredCapabilityIssue[];
    };

/**
 * Resolve a caller's declared capabilities against the host-installed registry.
 *
 * TOTAL: every rejection is a structured issue. The rule is stated once, here,
 * and it never widens the installed set — see the module header.
 */
export function resolveDeclaredValidatorCapabilities(
  declared: readonly SupportedValidatorV3[] | undefined,
  registry: ValidatorRegistry,
): DeclaredCapabilityResolution {
  const installed: readonly ValidatorKey[] = registry.keys;
  if (declared === undefined) {
    return {
      kind: "effective",
      capabilities: capabilitiesOfValidatorRegistry(registry),
    };
  }
  const issues: DeclaredCapabilityIssue[] = [];
  const capabilities: SupportedValidatorV3[] = [];
  const seen = new Set<string>();
  for (const entry of declared) {
    const matches = installed.filter((key) => key.id === entry.validator);
    if (matches.length === 0) {
      issues.push(
        Object.freeze({
          code: "validator-capability-not-installed" as const,
          validator: entry.validator,
          ...(entry.version === undefined ? {} : { version: entry.version }),
          message:
            "validator " +
            describeDeclared(entry) +
            " is not installed in this host: no registered capability has that id, so the declaration cannot be substantiated",
        }),
      );
      continue;
    }
    let resolved: ValidatorKey | undefined;
    if (entry.version === undefined) {
      if (matches.length > 1) {
        issues.push(
          Object.freeze({
            code: "ambiguous-validator-version" as const,
            validator: entry.validator,
            message:
              "validator " +
              JSON.stringify(entry.validator) +
              " is installed at " +
              String(matches.length) +
              " versions (" +
              matches.map((key) => validatorKeyText(key)).join(", ") +
              ") and the declaration names none: an unversioned declaration is pinned only when exactly one installed version exists, never by registry order",
          }),
        );
        continue;
      }
      resolved = matches[0];
    } else {
      resolved = matches.find((key) => key.version === entry.version);
    }
    if (resolved === undefined) {
      issues.push(
        Object.freeze({
          code: "validator-capability-not-installed" as const,
          validator: entry.validator,
          version: entry.version,
          message:
            "validator " +
            describeDeclared(entry) +
            " is not installed in this host: the installed versions of " +
            JSON.stringify(entry.validator) +
            " are " +
            (matches.length === 0
              ? "none"
              : matches.map((key) => validatorKeyText(key)).join(", ")) +
            ", and capability matching is identity, never ordering",
        }),
      );
      continue;
    }
    const key = validatorKeyText(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    capabilities.push(
      Object.freeze({ validator: resolved.id, version: resolved.version }),
    );
  }
  if (issues.length > 0) {
    return { kind: "refused", issues: Object.freeze(issues) };
  }
  return { kind: "effective", capabilities: Object.freeze(capabilities) };
}

/** Describe one declared capability as `"id"@version` for a diagnostic. */
function describeDeclared(entry: SupportedValidatorV3): string {
  return entry.version === undefined
    ? JSON.stringify(entry.validator) + " (any version)"
    : JSON.stringify(entry.validator) + "@" + String(entry.version);
}
