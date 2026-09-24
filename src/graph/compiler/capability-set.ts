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
