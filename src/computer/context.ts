import { COMPUTER_TOOL_NAMES } from "../loader/computer-grants.ts";
import { renderInjectBlock } from "../prompt/blocks.ts";

export interface ComputerContextOptions {
  tools: readonly string[];
  presentation?: "native" | "discover" | "code";
  discoverInvocation?: "native" | "call";
}

const INPUT_TOOLS = ["computer_click", "computer_move", "computer_type", "computer_key", "computer_scroll", "computer_drag"] as const;

export function buildComputerContext(options: ComputerContextOptions): string {
  const tools = new Set(options.tools);
  if (!COMPUTER_TOOL_NAMES.some(name => tools.has(name))) return "";

  const instructions = ["Prefer a suitable dedicated API, CLI, or application tool when it can complete the task. Use the available computer tools when the task requires observing or interacting with the desktop."];
  if (options.presentation === "discover") {
    instructions.push("The computer names below are authorized capabilities. First inspect a capability with graph_worker_tools(action=\"describe\", name=...). " +
      (options.discoverInvocation === "call"
        ? "Invoke it with graph_worker_tools(action=\"call\", name=..., arguments=...); these names are not direct tool calls."
        : "Then call its native tool only after describe has exposed the schema."));
  } else if (options.presentation === "code") {
    instructions.push("First inspect the authorized computer schemas with graph_worker_tools(action=\"describe\", name=...), then invoke them through graph_worker_code with await tools.call(name, args). These names are not direct tool calls.");
  }

  if (tools.has("computer_status")) {
    instructions.push("Use computer_status before the first desktop action or after capture/input errors to check platform support, helpers, and permissions. A valid plan is not proof that an operation succeeded.");
  }
  if (tools.has("computer_permissions")) {
    instructions.push("On a permission denial, use computer_permissions(request=true) to ask the OS for missing permissions. Follow the reported next_action: if user action is required, explain the requested approval and any host restart, then wait. After the user completes it, recheck with computer_permissions without request; do not loop permission requests. Input metadata.granted and metadata.screen_capture are independent. A request, dry_run, successful command, or valid screenshot does not prove OS authorization; report unknown or denied states accurately.");
  }
  if (tools.has("computer_windows")) instructions.push("Use computer_windows to identify the target application's current window IDs.");
  if (tools.has("computer_displays")) instructions.push("Use computer_displays to identify the display and its screen bounds when working across displays.");
  if (tools.has("computer_focus")) instructions.push("Use computer_focus with an observed window ID before sending input to that window; a focus failure must be resolved before proceeding.");

  const inputs = INPUT_TOOLS.filter(name => tools.has(name));
  if (tools.has("computer_screenshot")) {
    instructions.push("Use computer_screenshot to observe the current target before choosing coordinates, and again after focusing or an action to verify the visible result. Convert image pixels to screen coordinates using metadata.pixel_scale and metadata.origin; if origin is unknown, locate the target before clicking. Do not reuse stale coordinates after the UI changes.");
  } else if (inputs.length > 0) {
    instructions.push("Obtain current visual evidence through another permitted observation capability before choosing screen coordinates. Do not guess positions or claim a result was visually checked without observing it.");
  }
  if (inputs.length > 0) {
    instructions.push(`Use ${inputs.join(", ")} for small, deliberate actions. Check the resulting UI before continuing; an input command completing does not prove the requested application change occurred.`);
  }
  instructions.push("Do not change configuration, tool grants, or OS privacy settings to authorize yourself. Surface an unavailable capability or a denied permission and follow the permitted recovery path; do not claim success for a failed operation or dry_run.");
  return renderInjectBlock({ title: "Computer use workflow", instruction: instructions });
}
