export type ComputerPermission = "accessibility" | "screen_capture" | "automation" | "desktop";

export const PERMISSION_REQUEST_GUIDANCE =
  "Call computer_permissions({request:true}) to request missing OS permissions where supported. Wait for user approval and recheck before retrying. This tool verifies Accessibility and Screen Recording on macOS; Automation for System Events requires separate user approval and is not verified by these probes.";

export const PERMISSION_USER_GUIDANCE =
  "Wait for the user to resolve the reported OS permission issue. On macOS, approve Accessibility / Screen Recording for the application launching the host in System Settings > Privacy & Security, and Automation for System Events when required. The OS may not show a repeated prompt. Restart the host if required, then call computer_permissions({}) to check again; do not loop permission requests.";

export function permissionRecovery(userActionRequired = false): Record<string, unknown> {
  return {
    error: true,
    error_code: "permission_denied",
    next_action: userActionRequired
      ? { type: "user_action", instruction: PERMISSION_USER_GUIDANCE, recheck: { tool: "computer_permissions", args: {} } }
      : { tool: "computer_permissions", args: { request: true } },
  };
}

export function deniedComputerPermission(output: string): ComputerPermission | undefined {
  if (/Accessibility permission is not granted|not allowed (?:assistive access|to send keystrokes)|AXErrorAPIDisabled|\(-25211\)/i.test(output)) return "accessibility";
  if (/not authori[sz]ed to send Apple events|not permitted to send Apple events|\(-1743\)/i.test(output)) return "automation";
  if (/Screen (?:Recording|Capture) (?:permission|access) (?:is )?(?:not granted|denied|not permitted)/i.test(output)) return "screen_capture";
  if (/Authorization required, but no authorization protocol specified|Invalid MIT-MAGIC-COOKIE/i.test(output)) return "desktop";
  return undefined;
}
