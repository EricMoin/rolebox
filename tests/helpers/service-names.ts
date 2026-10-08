import type { ServiceName } from "../../src/core/service-names.ts";

/**
 * Widen a synthetic service name to the closed `ServiceName` union.
 *
 * The core is name-keyed machinery and these suites deliberately build
 * synthetic service graphs whose names ("alpha", "svc1", ...) are not members
 * of the real registry. This is the one place the widening is justified —
 * production code declares and looks up services by `SERVICE_NAMES` members
 * and never needs a cast.
 */
export function fakeServiceName(name: string): ServiceName {
  return name as ServiceName;
}

/** Widen synthetic dependency names to the closed `ServiceName` union (see {@link fakeServiceName}). */
export function fakeServiceNames(names: readonly string[]): ServiceName[] {
  return names as ServiceName[];
}
