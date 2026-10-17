import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** The personal agent's thread: one per environment, never cleared. */
export const PERSONAL_AGENT_THREAD_ID = ThreadId.make("personal-agent");

export const PersonalAgentEnsureInput = Schema.Struct({
  /** Used only when the thread does not exist yet. */
  modelSelection: Schema.optional(ModelSelection),
});
export type PersonalAgentEnsureInput = typeof PersonalAgentEnsureInput.Type;

export const PersonalAgentEnsureResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type PersonalAgentEnsureResult = typeof PersonalAgentEnsureResult.Type;
