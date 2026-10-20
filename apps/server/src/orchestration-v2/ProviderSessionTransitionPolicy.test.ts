import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { decideProviderSessionTransition } from "./ProviderSessionTransitionPolicy.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const base = {
  driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:account:one" },
  modelSelection: { instanceId, model: "gpt-5.1-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspace: "/repo",
};

it.each([
  ["claude:shared:max", "claude:shared:max", "restart_and_resume"],
  ["claude:shared:max", "claude:shared:other", "create_with_handoff"],
  ["claude:home:/account-a", "claude:home:/account-b", "create_with_handoff"],
  ["claude:home:/account-a", "claude:shared:max", "create_with_handoff"],
  ["claude:home:/account-a", "claude:home:/account-a", "restart_and_resume"],
] as const)("classifies Claude instance switches from %s to %s", (source, target, expected) => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const current = {
    ...base,
    driver: claudeDriver,
    continuationIdentity: { driverKind: claudeDriver, continuationKey: source },
    modelSelection: { instanceId: ProviderInstanceId.make("claude-a"), model: "sonnet" },
  };
  assert.deepEqual(
    decideProviderSessionTransition({
      current,
      target: {
        ...current,
        continuationIdentity: { driverKind: claudeDriver, continuationKey: target },
        modelSelection: {
          ...current.modelSelection,
          instanceId: ProviderInstanceId.make("claude-b"),
        },
        available: true,
      },
    }),
    { type: expected },
  );
});

it("reuses compatible sessions and treats interaction mode as turn-scoped", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: { ...base, interactionMode: "plan", available: true },
    }),
    { type: "reuse" },
  );
});

it("uses the adapter's selection transition classification", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        available: true,
      },
      selectionTransition: { type: "apply_on_next_turn" },
    }),
    { type: "switch_model_in_session" },
  );
  assert.deepEqual(
    decideProviderSessionTransition({
      current: {
        ...base,
      },
      target: {
        ...base,
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        available: true,
      },
      selectionTransition: { type: "restart_session" },
    }),
    { type: "restart_and_resume" },
  );
});

it("restarts compatible instances for workspace or runtime changes", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: { ...base, workspace: "/other", available: true },
    }),
    { type: "restart_and_resume" },
  );
});

it("preserves handoff and missing-classification outcomes across workspace changes", () => {
  const target = {
    ...base,
    modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
    workspace: "/other",
    available: true,
  };
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target,
      selectionTransition: { type: "create_with_handoff" },
    }),
    { type: "create_with_handoff" },
  );
  assert.deepEqual(decideProviderSessionTransition({ current: base, target }), {
    type: "reject",
    reason: "The provider adapter did not classify the selection change.",
  });
});

it("uses portable handoff for incompatible continuation identities", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: {
          ...base.modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        },
        continuationIdentity: { driverKind: driver, continuationKey: "codex:account:other" },
        available: true,
      },
    }),
    { type: "create_with_handoff" },
  );
});
