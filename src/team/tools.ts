import { z } from "zod";
import { defineTool } from "../platform/ports/tool-factory.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../platform/types.ts";
import type { TeamRuntime } from "./runtime.ts";

const teamId = z.string().min(1).describe("Team ID returned by team_create or team_status");

export function createTeamTools(source: TeamRuntime | ((context: CanonicalToolContext) => TeamRuntime)): Record<string, CanonicalToolDef> {
  const resolve = (context: CanonicalToolContext) => typeof source === "function" ? source(context) : source;
  return {
    team_list_roles: defineTool({
      description: "Discover top-level roles available for peer collaboration. Works without an active role. Private subroles are not team candidates.",
      args: {},
      async execute(_args, context) { const runtime = resolve(context); return JSON.stringify(runtime.roles()); },
    }),
    team_create: defineTool({
      description: "Create a durable team for complementary specialties. The current role/session becomes its creator. Add peers with team_add.",
      args: { name: z.string().min(1).max(200), goal: z.string().min(1).max(16000), max_turns: z.number().int().min(1).max(100).optional() },
      async execute(args, context) { const runtime = resolve(context); return JSON.stringify(runtime.create(context, args.name, args.goal, args.max_turns)); },
    }),
    team_add: defineTool({
      description: "Creator only: record a top-level role as a team member. This does not start a turn; the member's first woken event (a message or task event addressed to it) starts it with the goal, roster and tasks.",
      args: { team_id: teamId, role_id: z.string().min(1) },
      async execute(args, context) { const runtime = resolve(context); return JSON.stringify(runtime.add(context, args.team_id, args.role_id)); },
    }),
    team_send_event: defineTool({
      description: "Publish a peer message or task event. task_claim atomically reserves a task; act only after success. Claim leases last 30 minutes and can be renewed. Complete/release only tasks you own. Messages, offered/completed/released tasks wake peers; claims and turn notices do not. Recipients affect wake routing; every event is readable by the whole team.",
      args: { team_id: teamId, kind: z.enum(["message", "task_offer", "task_claim", "task_complete", "task_release"]),
        content: z.string().min(1).max(16000), task_id: z.string().min(1).max(200).optional(), recipient: z.string().min(1).optional() },
      async execute(args, context) { const runtime = resolve(context); return JSON.stringify(runtime.send(context, args.team_id, args)); },
    }),
    team_status: defineTool({
      description: "Read your teams or one team's roster, claims, delivery errors and durable event stream. Closed teams are hidden from the team list unless include_deleted is set; reading one by team_id always works. Reading does not acknowledge or discard pending events.",
      args: { team_id: teamId.optional(), after_seq: z.number().int().min(0).optional(), include_deleted: z.boolean().optional() },
      async execute(args, context) {
        const runtime = resolve(context);
        if (!args.team_id) return JSON.stringify(runtime.list(context, args.include_deleted).map(s => ({ id: s.id, name: s.name, status: s.status, turns: s.turns, maxTurns: s.maxTurns })));
        const state = runtime.status(context, args.team_id);
        return JSON.stringify({ ...state, events: state.events.filter(e => e.seq > (args.after_seq ?? 0)) });
      },
    }),
    team_remove: defineTool({
      description: "Creator only: cancel and remove a team member, broadcast departure, and release unfinished claims. The remaining team stays paused until team_resume.",
      args: { team_id: teamId, member_id: z.string().min(1) },
      async execute(args, context) { const runtime = resolve(context); await runtime.remove(context, args.team_id, args.member_id); return "Member removed; team remains paused. Use team_resume to continue."; },
    }),
    team_delete: defineTool({
      description: "Creator only: cancel team work and close the team. Durable history is retained for inspection; no further work is scheduled.",
      args: { team_id: teamId },
      async execute(args, context) { const runtime = resolve(context); await runtime.delete(context, args.team_id); return "Team closed"; },
    }),
    team_resume: defineTool({
      description: "Creator only: resume a paused team after inspecting errors and existing artifacts. Unacknowledged events may be replayed. Does not reset the turn budget.",
      args: { team_id: teamId },
      async execute(args, context) {
        const runtime = resolve(context);
        const unresolved = await runtime.resume(context, args.team_id);
        return unresolved.length ? `Team resumed with unresolved members: ${unresolved.join("; ")}` : "Team resumed";
      },
    }),
  };
}
