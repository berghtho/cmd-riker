import {
  Agent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  Commitment,
  CommitmentDraft,
  ConversationMessage,
  ActingAuthority,
  ActingAuthorityEffectRequest,
  ActingAuthorityEvent,
  ActingAuthorityHandoff,
  StandingOrder,
  StandingOrderDraft,
  WorkerQuestion,
  WorkerSession,
} from "../authoritative-state/index.ts";
import {
  defaultLeadModelRequirements,
  type LeadModelRequirements,
  type ModelCandidateValidation,
} from "../orchestration-core/index.ts";
import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "../model-selection.ts";
import type { TargetProjectOperationResult } from "../target-project-operations/index.ts";

export type PiTurnRequest = {
  conversation: readonly ConversationMessage[];
  ownerInput: string;
  modelSelection: ModelSelection;
  commitments?: readonly Commitment[];
  commitmentActions?: {
    record(draft: CommitmentDraft): Commitment;
    recordOwnerAttention(
      commitmentId: string,
      input: {
        kind: "owner-reserved-decision" | "recovery-exhausted" | "trusted-base-loss" | "mission-critical-impairment";
        reason: string;
        nextAction: string;
      },
    ): void;
    accept(commitmentId: string): void;
    resume(commitmentId: string): void;
    control(
      commitmentId: string,
      action: "pause" | "cancel" | "supersede",
      reason: string,
      replacementCommitmentId?: string,
    ): void;
    executeOperation(
      commitmentId: string,
      operation: "test",
      actingAuthorityEffect?: ActingAuthorityEffectRequest,
    ): Promise<TargetProjectOperationResult>;
  };
  standingOrders?: readonly StandingOrder[];
  actingAuthority?: ActingAuthority;
  authorityActions?: {
    recordStandingOrder(draft: StandingOrderDraft): StandingOrder;
    revokeStandingOrder(standingOrderId: string, reason: string): void;
    beginActingAuthority(input: {
      commitmentIds: string[];
      standingOrderIds: string[];
      ownerInstructionQuote: string;
    }): ActingAuthority;
    recordActingAuthorityEvent(
      actingAuthorityId: string,
      input: Omit<ActingAuthorityEvent, "id" | "recordedAt" | "effect" | "decision"> & {
        effect?: Omit<NonNullable<ActingAuthorityEvent["effect"]>, "standingOrderId">;
        decision?: Omit<NonNullable<ActingAuthorityEvent["decision"]>, "standingOrderId">;
      },
    ): ActingAuthorityEvent;
    prepareActingAuthorityHandoff(
      actingAuthorityId: string,
    ): ActingAuthorityHandoff;
  };
  workers?: readonly WorkerSession[];
  workerQuestions?: readonly WorkerQuestion[];
  workerActions?: {
    capabilities?: {
      nativeHarness: "codex" | "claude" | "copilot";
      effectful: boolean;
      nativeQuestions: boolean;
      cancellation: boolean;
    };
    delegate(input: {
      objective: string;
      prompt: string;
      commitmentId?: string;
      recoveryOfWorkerSessionId?: string;
      recoveryReason?: string;
    }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
    delegateEffectful?(input: {
      objective: string;
      prompt: string;
      commitmentId: string;
      targets: string[];
      actingAuthorityEffect?: ActingAuthorityEffectRequest;
    }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
    delegateReview?(input: {
      implementationWorkerSessionId: string;
      prompt: string;
    }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
    adjudicateReview?(input: {
      commitmentId: string;
      decisions: Array<{
        reviewFindingId: string;
        disposition: "must-fix" | "documented-exception" | "follow-up";
        rationale: string;
      }>;
    }): void;
    reserveOwnerDecision?(questionId: string, reason: string): void;
    answer?(questionId: string, answers: Record<string, string[]>): Promise<void>;
    cancel?(workerSessionId: string, reason: string): Promise<void>;
  };
};

export interface PiTurnAdapter {
  validateSelection(
    modelSelection: ModelSelection,
    requirements?: LeadModelRequirements,
  ): Promise<ModelCandidateValidation>;
  completeTurn(request: PiTurnRequest): Promise<{ content: string }>;
}

export class PiTurnFailure extends Error {
  readonly kind: "unavailable" | "aborted" | "invalid-response" | "turn-failed";
  readonly commitmentMutationApplied: boolean;

  constructor(
    kind: PiTurnFailure["kind"],
    message: string,
    commitmentMutationApplied: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.kind = kind;
    this.commitmentMutationApplied = commitmentMutationApplied;
  }
}

export class DeterministicTurnAdapter implements PiTurnAdapter {
  private readonly response: string | undefined;

  constructor(response?: string) {
    this.response = response;
  }

  async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
    const priorTurns = request.conversation.filter((message) => message.role === "lead-agent").length;
    return {
      content:
        this.response ?? `Deterministic turn ${priorTurns + 1}: ${request.ownerInput}`,
    };
  }

  async validateSelection(
    modelSelection: ModelSelection,
    requirements = defaultLeadModelRequirements,
  ): Promise<ModelCandidateValidation> {
    assertSupportedModelSelection(modelSelection);
    return {
      modelSelection,
      requirements,
      hardGates: passedHardGates(),
      availability: "passed",
      observedAt: new Date().toISOString(),
    };
  }
}

export class PiAgentTurnAdapter implements PiTurnAdapter {
  // Pi owns credential resolution and refresh; no credential crosses this adapter's interface.
  private authenticatedModels: Promise<ModelRuntime> | undefined;

  async validateSelection(
    modelSelection: ModelSelection,
    requirements = defaultLeadModelRequirements,
  ): Promise<ModelCandidateValidation> {
    const observedAt = new Date().toISOString();
    try {
      assertSupportedModelSelection(modelSelection);
    } catch {
      return {
        modelSelection,
        requirements,
        hardGates: failedHardGates(),
        availability: "failed",
        observedAt,
      };
    }
    let execution: Awaited<ReturnType<PiAgentTurnAdapter["resolveExecution"]>>;
    try {
      execution = await this.resolveExecution(modelSelection);
    } catch {
      return {
        modelSelection,
        requirements,
        hardGates: {
          ...unknownHardGates(),
          integration: "passed",
          dataHandling: "passed",
        },
        availability: "failed",
        observedAt,
      };
    }
    let availability: ModelCandidateValidation["availability"] = "passed";
    let intendedIdentity: ModelCandidateValidation["hardGates"]["intendedIdentity"] = "passed";
    let catalogModel:
      | {
          id?: unknown;
          capabilities?: unknown;
          context_window?: unknown;
          input_cost_per_million_usd?: unknown;
        }
      | undefined;
    try {
      if (modelSelection.api === "openai-completions") {
        const response = await fetch(`${modelSelection.baseUrl.replace(/\/$/, "")}/models`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}.`);
        const catalog = (await response.json()) as { data?: typeof catalogModel[] };
        catalogModel = catalog.data?.find((model) => model?.id === modelSelection.model);
        if (!catalogModel) {
          throw new Error("The configured Model is absent from the local Model catalog.");
        }
      }
    } catch {
      availability = "failed";
      intendedIdentity = "unknown";
    }
    const catalogCapabilities = Array.isArray(catalogModel?.capabilities)
      ? catalogModel.capabilities
      : undefined;
    const requiredCapabilities = requirements.requiredCapabilities.every((capability) =>
      catalogModel
        ? catalogCapabilities?.includes(capability)
        : execution.model.input.includes(capability),
    )
      ? "passed"
      : catalogModel && !catalogCapabilities
        ? "unknown"
        : "failed";
    const contextValue = catalogModel
      ? catalogModel.context_window
      : execution.model.contextWindow;
    const context = typeof contextValue !== "number"
      ? "unknown"
      : contextValue >= requirements.minimumContextWindow
        ? "passed"
        : "failed";
    const dataHandling =
      requirements.dataHandling === "supported-integrations" ||
      modelSelection.api === "openai-completions"
        ? "passed"
        : "failed";
    const costValue = catalogModel
      ? catalogModel.input_cost_per_million_usd
      : execution.model.cost.input;
    const cost = requirements.maximumInputCostPerMillionUsd === null
      ? "passed"
      : typeof costValue !== "number"
        ? "unknown"
        : costValue <= requirements.maximumInputCostPerMillionUsd
          ? "passed"
          : "failed";
    return {
      modelSelection,
      requirements,
      hardGates: {
        ...passedHardGates(),
        intendedIdentity,
        requiredCapabilities,
        context,
        dataHandling,
        cost,
      },
      availability,
      observedAt,
    };
  }

  async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
    let commitmentMutationApplied = false;
    try {
      assertSupportedModelSelection(request.modelSelection);
      let execution: Awaited<ReturnType<PiAgentTurnAdapter["resolveExecution"]>>;
      try {
        execution = await this.resolveExecution(request.modelSelection);
      } catch (error) {
        throw new PiTurnFailure("unavailable", "The configured Model is unavailable.", false, error);
      }
      const mutationObserver = {
        onMutation: () => {
          commitmentMutationApplied = true;
        },
      };
      const tools = [
        ...commitmentTools(request, mutationObserver),
        ...authorityTools(request, mutationObserver),
        ...workerTools(request, mutationObserver),
      ];
      const commitmentContext = (request.commitments ?? [])
        .map(
          (commitment) =>
            `${commitment.id}: ${commitment.state}` +
            (commitment.condition
              ? ` (${commitment.condition.kind}: ${commitment.condition.reason}; next: ${commitment.condition.nextAction})`
              : "") +
            ` - ${commitment.outcome}`,
        )
        .join("\n");
      const workerContext = (request.workers ?? [])
        .map(
          (worker) =>
            `${worker.id}: ${worker.state} - ${worker.assignment.objective} ` +
            `(attempt ${worker.currentExecutionAttemptId})` +
            (worker.outcome
              ? `; outcome ${worker.outcome.status}: ${worker.outcome.summary}; ` +
                `${worker.outcome.affectedArtifacts.length} affected artifact(s); ` +
                `${worker.outcome.unresolvedUncertainty ?? "no unresolved uncertainty"}`
              : ""),
        )
        .join("\n");
      const questionContext = (request.workerQuestions ?? [])
        .filter((question) => question.status === "open")
        .map(
          (question) =>
            `${question.id} from Worker Session ${question.workerSessionId}: ` +
            question.questions.map((item) => `${item.id}: ${item.question}`).join("; "),
        )
        .join("\n");
      const standingOrderContext = (request.standingOrders ?? [])
        .map((order) =>
          `${order.id}: ${order.state} until ${order.validUntil}; Commitments ${order.commitmentIds.join(", ")}; ` +
          `effects ${order.effectClasses.join(", ")}; targets ${order.targets.join(", ")}; ` +
          `irreversible ${order.allowIrreversibleEffects}; externally binding ${order.allowExternallyBindingEffects}`
        )
        .join("\n");
      const actingAuthorityContext = request.actingAuthority
        ? `${request.actingAuthority.id}: ${request.actingAuthority.state}; Commitments ` +
          `${request.actingAuthority.commitmentIds.join(", ")}; ${request.actingAuthority.events.length} event(s)`
        : "none";
      const initialState = {
        systemPrompt:
          "You are CMD Riker's Lead Agent: confident, composed, warm, observant, decisive, candid, " +
          "occasionally witty, proactive, and loyal to the Owner's intent without becoming passive. " +
          "Enjoy the work, challenge weak plans professionally, and serve the Owner without theatrical role-play. " +
          "Distinguish conversation from accepted outcome-oriented work. When you visibly accept work that can " +
          "be completed in this response, call record_commitment before the final response. Use objective " +
          "response-includes criteria only for exact observable response postconditions. Reserve subjective " +
          "quality and Owner choices with owner-judgment. Never call accept_commitment unless this Owner input " +
          "explicitly accepts the named waiting Commitment. Use resume_commitment only for a blocked or paused " +
          "Commitment the Owner asks to continue. Use control_commitment only for the Owner's explicit pause, " +
          "cancel, or supersede instruction." +
          " For a Target Project test outcome, record one Commitment with a target-project-operation " +
           "criterion and then call run_target_project_operation. Never construct Task CLI commands." +
           (commitmentContext ? `\nCurrent Commitments:\n${commitmentContext}` : "") +
           (request.authorityActions
             ? "\nStanding Orders are created or revoked only from explicit Owner instructions. Silence never begins Acting Authority. " +
               "During Acting Authority, record material decisions, effects, exceptions, risks, and uncertainty. " +
               "When the Owner returns, prepare the durable handoff before returning command."
             : "") +
           (standingOrderContext ? `\nStanding Orders:\n${standingOrderContext}` : "") +
           `\nActing Authority: ${actingAuthorityContext}` +
           (request.workerActions ? workerCapabilityPrompt(request.workerActions) : "") +
           (workerContext ? `\nCurrent Worker Sessions:\n${workerContext}` : "") +
           (questionContext ? `\nOpen Worker questions:\n${questionContext}` : ""),
        model: execution.model,
        messages: request.conversation.map(toPiMessage),
        tools,
      };
      const agent = new Agent(
        request.modelSelection.api === "openai-completions"
          ? {
              initialState,
              streamFn: execution.streamFn,
              // Pi's OpenAI client requires a value, while the supported loopback endpoint is keyless.
              // This fixed public marker prevents any environment credential lookup.
              getApiKey: () => "cmd-riker-local-no-secret",
              toolExecution: "sequential",
            }
          : {
              initialState,
              streamFn: execution.streamFn,
              toolExecution: "sequential",
            },
      );

      try {
        await agent.prompt(request.ownerInput);
      } catch (error) {
        throw new PiTurnFailure(
          "turn-failed",
          "The Lead Model turn failed during execution.",
          commitmentMutationApplied,
          error,
        );
      }
      const response = agent.state.messages.at(-1);
      if (!response || response.role !== "assistant") {
        throw new PiTurnFailure(
          "invalid-response",
          "Pi turn completed without an assistant response.",
          commitmentMutationApplied,
        );
      }
      if (response.stopReason === "aborted") {
        throw new PiTurnFailure(
          "aborted",
          `Pi turn failed: ${response.errorMessage ?? response.stopReason}.`,
          commitmentMutationApplied,
        );
      }
      if (response.stopReason === "error") {
        throw new PiTurnFailure(
          "unavailable",
          `Pi turn failed: ${response.errorMessage ?? response.stopReason}.`,
          commitmentMutationApplied,
        );
      }
      if (
        response.provider !== request.modelSelection.provider ||
        response.model !== request.modelSelection.model ||
        response.api !== request.modelSelection.api
      ) {
        throw new PiTurnFailure(
          "invalid-response",
          "Pi turn returned a different Model Selection than requested.",
          commitmentMutationApplied,
        );
      }
      const content = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      if (!content) {
        throw new PiTurnFailure(
          "invalid-response",
          "Pi turn completed without response text.",
          commitmentMutationApplied,
        );
      }
      return { content };
    } catch (error) {
      if (error instanceof PiTurnFailure) throw error;
      throw new PiTurnFailure(
        "turn-failed",
        error instanceof Error ? error.message : "Pi turn failed.",
        commitmentMutationApplied,
        error,
      );
    }
  }

  private async resolveExecution(selection: ModelSelection): Promise<{
    model: Model<Api>;
    streamFn: ModelRuntime["streamSimple"];
  }> {
    if (selection.api === "openai-completions") {
      return {
        model: toPiModel(selection),
        streamFn: streamSimple,
      };
    }
    this.authenticatedModels ??= import("@earendil-works/pi-coding-agent").then(
      ({ ModelRuntime }) =>
        ModelRuntime.create({
          allowModelNetwork: false,
          modelsPath: null,
          modelsStore: new InMemoryModelsStore(),
          refreshOnCreate: false,
        }),
    );
    const models = await this.authenticatedModels;
    const model = models.getModel(selection.provider, selection.model);
    if (!model) {
      throw new Error(`Configured Model ${selection.provider}/${selection.model} is unavailable.`);
    }
    if (
      model.provider !== selection.provider ||
      model.id !== selection.model ||
      model.api !== selection.api ||
      model.baseUrl !== "https://chatgpt.com/backend-api"
    ) {
      throw new Error("Pi resolved an unexpected OpenAI Codex Model definition.");
    }
    const auth = await models.checkAuth(selection.provider);
    if (!auth) {
      throw new Error(`Pi authentication for ${selection.provider} is unavailable.`);
    }
    return {
      model,
      streamFn: models.streamSimple.bind(models),
    };
  }
}

function passedHardGates(): ModelCandidateValidation["hardGates"] {
  return {
    integration: "passed",
    authentication: "passed",
    intendedIdentity: "passed",
    requiredCapabilities: "passed",
    context: "passed",
    dataHandling: "passed",
    cost: "passed",
  };
}

function failedHardGates(): ModelCandidateValidation["hardGates"] {
  return Object.fromEntries(
    Object.keys(passedHardGates()).map((gate) => [gate, "failed"]),
  ) as ModelCandidateValidation["hardGates"];
}

function unknownHardGates(): ModelCandidateValidation["hardGates"] {
  return Object.fromEntries(
    Object.keys(passedHardGates()).map((gate) => [gate, "unknown"]),
  ) as ModelCandidateValidation["hardGates"];
}

const commitmentCriterionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("response-includes"),
    description: Type.String({ minLength: 1 }),
    expectedText: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("owner-judgment"),
  }),
  Type.Object({
    kind: Type.Literal("target-project-operation"),
    description: Type.String({ minLength: 1 }),
    operation: Type.Literal("test"),
  }),
]);

function commitmentTools(
  request: PiTurnRequest,
  observer: { onMutation(): void },
): AgentTool[] {
  if (!request.commitmentActions) return [];
  const actions = request.commitmentActions;
  return [
    {
      name: "record_commitment",
      label: "Record Commitment",
      description:
        "Visibly accept one outcome-oriented unit of work and declare how its response outcome is accepted.",
      parameters: Type.Object({
        outcome: Type.String({ minLength: 1 }),
        criteria: Type.Array(commitmentCriterionSchema, { minItems: 1 }),
        review: Type.Optional(Type.Object({
          required: Type.Literal(true),
          reasons: Type.Array(Type.Union([
            Type.Literal("public-module"),
            Type.Literal("authorization"),
            Type.Literal("data"),
            Type.Literal("deployment"),
            Type.Literal("self-repair"),
            Type.Literal("objective-check-gap"),
          ]), { minItems: 1 }),
        })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const commitment = actions.record(params as CommitmentDraft);
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text: `Commitment ${commitment.id} is active and will be verified against the final response.`,
            },
          ],
          details: { commitmentId: commitment.id, state: commitment.state },
        };
      },
    },
    {
      name: "run_target_project_operation",
      label: "Run Target Project Operation",
      description:
        "Run and verify one declared semantic Target Project operation for an active Commitment.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
        operation: Type.Literal("test"),
        actingAuthorityEffect: Type.Optional(actingAuthorityEffectRequestSchema),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId, operation, actingAuthorityEffect } = params as {
          commitmentId: string;
          operation: "test";
          actingAuthorityEffect?: ActingAuthorityEffectRequest;
        };
        const result = await actions.executeOperation(
          commitmentId,
          operation,
          actingAuthorityEffect,
        );
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text:
                `Operation attempt ${result.operationAttemptId} ended ${result.status}; ` +
                `${result.affectedArtifacts.length} affected artifact(s); ` +
                `${result.uncertainty ? result.uncertainty.reason : "no unresolved uncertainty"}.`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: "record_material_commitment_attention",
      label: "Record Material Commitment Attention",
      description:
        "Record an Owner-facing Commitment blocker only for a reserved decision, exhausted recovery, trusted-base loss, or mission-critical impairment, with the actual fact and recovery condition.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
        kind: Type.Union([
          Type.Literal("owner-reserved-decision"),
          Type.Literal("recovery-exhausted"),
          Type.Literal("trusted-base-loss"),
          Type.Literal("mission-critical-impairment"),
        ]),
        reason: Type.String({ minLength: 1 }),
        nextAction: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId, kind, reason, nextAction } = params as {
          commitmentId: string;
          kind: "owner-reserved-decision" | "recovery-exhausted" | "trusted-base-loss" | "mission-critical-impairment";
          reason: string;
          nextAction: string;
        };
        actions.recordOwnerAttention(commitmentId, { kind, reason, nextAction });
        observer.onMutation();
        return {
          content: [{ type: "text", text: `Material attention recorded for Commitment ${commitmentId}.` }],
          details: { commitmentId, kind },
        };
      },
    },
    {
      name: "resume_commitment",
      label: "Resume Commitment",
      description: "Bind a blocked or paused Commitment to this Owner turn so its outcome can continue.",
      parameters: Type.Object({ commitmentId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId } = params as { commitmentId: string };
        actions.resume(commitmentId);
        observer.onMutation();
        return {
          content: [{ type: "text", text: `Commitment ${commitmentId} resumed.` }],
          details: { commitmentId, state: "active" },
        };
      },
    },
    {
      name: "control_commitment",
      label: "Control Commitment",
      description: "Apply the Owner's explicit pause, cancellation, or supersession instruction.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
        action: Type.Union([
          Type.Literal("pause"),
          Type.Literal("cancel"),
          Type.Literal("supersede"),
        ]),
        reason: Type.String({ minLength: 1 }),
        replacementCommitmentId: Type.Optional(Type.String({ minLength: 1 })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId, action, reason, replacementCommitmentId } = params as {
          commitmentId: string;
          action: "pause" | "cancel" | "supersede";
          reason: string;
          replacementCommitmentId?: string;
        };
        actions.control(commitmentId, action, reason, replacementCommitmentId);
        observer.onMutation();
        const disposition =
          action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "superseded";
        return {
          content: [{ type: "text", text: `Commitment ${commitmentId} is ${disposition}.` }],
          details: { commitmentId, action },
        };
      },
    },
    {
      name: "accept_commitment",
      label: "Accept Commitment",
      description:
        "Record the Owner's explicit verdict for one Commitment currently awaiting Owner Acceptance.",
      parameters: Type.Object({ commitmentId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId } = params as { commitmentId: string };
        actions.accept(commitmentId);
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text: `Owner Acceptance recorded for Commitment ${commitmentId}.`,
            },
          ],
          details: { commitmentId, state: "accepted" },
        };
      },
    },
  ];
}

const standingOrderEffectClassSchema = Type.Union([
  Type.Literal("product-decision"),
  Type.Literal("prioritization"),
  Type.Literal("test"),
  Type.Literal("merge"),
  Type.Literal("deploy"),
  Type.Literal("update"),
  Type.Literal("restart"),
  Type.Literal("self-repair"),
]);

const actingAuthorityEffectRequestSchema = Type.Object({
  actingAuthorityId: Type.String({ minLength: 1 }),
  commitmentId: Type.String({ minLength: 1 }),
  effectClass: standingOrderEffectClassSchema,
  target: Type.String({ minLength: 1 }),
  reversible: Type.Boolean(),
  externallyBinding: Type.Boolean(),
  incrementalSpendUsd: Type.Number({ minimum: 0 }),
});

function authorityTools(
  request: PiTurnRequest,
  observer: { onMutation(): void },
): AgentTool[] {
  if (!request.authorityActions) return [];
  const actions = request.authorityActions;
  return [
    {
      name: "record_standing_order",
      label: "Record Standing Order",
      description:
        "Record an explicit, bounded, expiring Owner instruction. Never infer this from silence or old conversation.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        instruction: Type.String({ minLength: 1 }),
        commitmentIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        effectClasses: Type.Array(standingOrderEffectClassSchema, { minItems: 1 }),
        targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        allowIrreversibleEffects: Type.Boolean(),
        allowExternallyBindingEffects: Type.Boolean(),
        maximumIncrementalSpendUsd: Type.Number({ minimum: 0 }),
        validUntil: Type.String({ minLength: 1 }),
        ownerInstructionQuote: Type.String({ minLength: 8 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const order = actions.recordStandingOrder(params as StandingOrderDraft);
        observer.onMutation();
        return {
          content: [{ type: "text", text: `Standing Order ${order.id} is active until ${order.validUntil}.` }],
          details: order,
        };
      },
    },
    {
      name: "revoke_standing_order",
      label: "Revoke Standing Order",
      description: "Revoke one Standing Order from the Owner's explicit instruction.",
      parameters: Type.Object({
        standingOrderId: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { standingOrderId, reason } = params as { standingOrderId: string; reason: string };
        actions.revokeStandingOrder(standingOrderId, reason);
        observer.onMutation();
        return {
          content: [{ type: "text", text: `Standing Order ${standingOrderId} revoked.` }],
          details: { standingOrderId, state: "revoked" },
        };
      },
    },
    {
      name: "begin_acting_authority",
      label: "Begin Acting Authority",
      description:
        "Begin an explicitly Owner-authorized absence period for bounded Commitments and active Standing Orders.",
      parameters: Type.Object({
        commitmentIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        standingOrderIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        ownerInstructionQuote: Type.String({ minLength: 8 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const acting = actions.beginActingAuthority(params as {
          commitmentIds: string[];
          standingOrderIds: string[];
          ownerInstructionQuote: string;
        });
        observer.onMutation();
        return {
          content: [{ type: "text", text: `Acting Authority ${acting.id} began within its recorded bounds.` }],
          details: acting,
        };
      },
    },
    {
      name: "record_acting_authority_event",
      label: "Record Acting Authority Event",
      description:
        "Record one material decision, effect, exception, risk, or uncertainty during active Acting Authority.",
      parameters: Type.Object({
        actingAuthorityId: Type.String({ minLength: 1 }),
        kind: Type.Union([
          Type.Literal("decision"),
          Type.Literal("effect"),
          Type.Literal("exception"),
          Type.Literal("risk"),
          Type.Literal("uncertainty"),
        ]),
        commitmentId: Type.String({ minLength: 1 }),
        summary: Type.String({ minLength: 1 }),
        evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        effect: Type.Optional(Type.Object({
          effectClass: standingOrderEffectClassSchema,
          target: Type.String({ minLength: 1 }),
          reversible: Type.Boolean(),
          externallyBinding: Type.Boolean(),
          incrementalSpendUsd: Type.Number({ minimum: 0 }),
          effectIntentId: Type.String({ minLength: 1 }),
        })),
        decision: Type.Optional(Type.Object({
          decisionClass: Type.Union([
            Type.Literal("product-decision"),
            Type.Literal("prioritization"),
          ]),
          target: Type.String({ minLength: 1 }),
        })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { actingAuthorityId, ...event } = params as Parameters<
          typeof actions.recordActingAuthorityEvent
        >[1] & { actingAuthorityId: string };
        const recorded = actions.recordActingAuthorityEvent(actingAuthorityId, event);
        observer.onMutation();
        return {
          content: [{ type: "text", text: `Acting Authority ${recorded.kind} ${recorded.id} recorded.` }],
          details: recorded,
        };
      },
    },
    {
      name: "prepare_acting_authority_handoff",
      label: "Prepare Acting Authority Handoff",
      description:
        "Prepare the returning Owner's durable decisions, effects, exceptions, risks, and uncertainty handoff before command returns.",
      parameters: Type.Object({ actingAuthorityId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { actingAuthorityId } = params as { actingAuthorityId: string };
        const handoff = actions.prepareActingAuthorityHandoff(actingAuthorityId);
        observer.onMutation();
        return {
          content: [{ type: "text", text: `Acting Authority handoff: ${JSON.stringify(handoff)}` }],
          details: handoff,
        };
      },
    },
  ];
}

function workerTools(
  request: PiTurnRequest,
  observer: { onMutation(): void },
): AgentTool[] {
  if (!request.workerActions) return [];
  const actions = request.workerActions;
  const capabilities = workerCapabilities(actions);
  const nativeName = nativeHarnessName(capabilities.nativeHarness);
  const tools: AgentTool[] = [
    {
      name: `delegate_read_only_${capabilities.nativeHarness}`,
      label: `Delegate Read-only ${nativeName} Worker`,
      description:
        `Start one bounded, read-only ${nativeName} Worker Session without waiting for its outcome.`,
      parameters: Type.Object({
        objective: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
        commitmentId: Type.Optional(Type.String({ minLength: 1 })),
        recoveryOfWorkerSessionId: Type.Optional(Type.String({ minLength: 1 })),
        recoveryReason: Type.Optional(Type.String({ minLength: 1 })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const result = await actions.delegate(
          params as {
            objective: string;
            prompt: string;
            commitmentId?: string;
            recoveryOfWorkerSessionId?: string;
            recoveryReason?: string;
          },
        );
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text:
                `Worker Session ${result.workerSessionId} started read-only ` +
                `execution attempt ${result.executionAttemptId}.`,
            },
          ],
          details: result,
        };
      },
    },
  ];
  if (capabilities.effectful && actions.delegateEffectful) {
    tools.push({
      name: `delegate_effectful_${capabilities.nativeHarness}`,
      label: `Delegate Effectful ${nativeName} Worker`,
      description:
        `Start one bounded ${nativeName} implementation assignment inside the technically enforced active Target Project checkout. Requires an active Commitment with declared test Verification.`,
      parameters: Type.Object({
        objective: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
        commitmentId: Type.String({ minLength: 1 }),
        targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
        actingAuthorityEffect: Type.Optional(actingAuthorityEffectRequestSchema),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const result = await actions.delegateEffectful!(
          params as {
            objective: string;
            prompt: string;
            commitmentId: string;
            targets: string[];
            actingAuthorityEffect?: ActingAuthorityEffectRequest;
          },
        );
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text:
                `Worker Session ${result.workerSessionId} started effectful ` +
                `execution attempt ${result.executionAttemptId} inside its Authorized Write Root.`,
            },
          ],
          details: result,
        };
      },
    });
  }
  if (actions.delegateReview) {
    tools.push({
      name: "delegate_independent_review",
      label: "Delegate Independent Review",
      description:
        "Start a separate read-only Worker Session to review one completed implementing Worker against criteria, evidence, and concrete risks.",
      parameters: Type.Object({
        implementationWorkerSessionId: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const result = await actions.delegateReview!(params as {
          implementationWorkerSessionId: string;
          prompt: string;
        });
        observer.onMutation();
        return {
          content: [{
            type: "text",
            text:
              `Independent Review Worker Session ${result.workerSessionId} started ` +
              `as execution attempt ${result.executionAttemptId}.`,
          }],
          details: result,
        };
      },
    });
  }
  if (actions.adjudicateReview) {
    tools.push({
      name: "adjudicate_review_findings",
      label: "Adjudicate Review Findings",
      description:
        "Record the Lead decision and rationale for every new Review finding before repair or Acceptance.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
        decisions: Type.Array(Type.Object({
          reviewFindingId: Type.String({ minLength: 1 }),
          disposition: Type.Union([
            Type.Literal("must-fix"),
            Type.Literal("documented-exception"),
            Type.Literal("follow-up"),
          ]),
          rationale: Type.String({ minLength: 1 }),
        }), { minItems: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        actions.adjudicateReview!(params as {
          commitmentId: string;
          decisions: Array<{
            reviewFindingId: string;
            disposition: "must-fix" | "documented-exception" | "follow-up";
            rationale: string;
          }>;
        });
        observer.onMutation();
        return {
          content: [{ type: "text", text: "Review findings were adjudicated by the Lead Agent." }],
          details: params,
        };
      },
    });
  }
  if (capabilities.nativeQuestions && actions.answer) {
    tools.push({
      name: "answer_worker_question",
      label: "Answer Worker Question",
      description: `Deliver the Owner's answer to one open native ${nativeName} question by durable identity.`,
      parameters: Type.Object({
        questionId: Type.String({ minLength: 1 }),
        answers: Type.Record(
          Type.String(),
          Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        ),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { questionId, answers } = params as {
          questionId: string;
          answers: Record<string, string[]>;
        };
        await actions.answer!(questionId, answers);
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text:
                `Answer recorded for Worker question ${questionId}; ` +
                "native delivery is pending confirmation.",
            },
          ],
          details: { questionId, deliveryState: "answer-recorded" },
        };
      },
    });
  }
  if (capabilities.nativeQuestions && actions.reserveOwnerDecision) {
    tools.push({
      name: "reserve_worker_question_for_owner",
      label: "Reserve Worker Question for Owner",
      description:
        "Classify one open Worker question as an Owner-reserved decision only when authority or product judgment requires the Owner. Answering remains conversational.",
      parameters: Type.Object({
        questionId: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { questionId, reason } = params as { questionId: string; reason: string };
        actions.reserveOwnerDecision!(questionId, reason);
        observer.onMutation();
        return {
          content: [{
            type: "text",
            text: `Worker question ${questionId} is reserved for an Owner decision in the Session View.`,
          }],
          details: { questionId },
        };
      },
    });
  }
  if (capabilities.cancellation && actions.cancel) {
    tools.push({
      name: "cancel_worker_session",
      label: "Cancel Worker Session",
      description:
        `Record cancellation intent, then interrupt one active ${nativeName} Worker Session. This does not roll back effects.`,
      parameters: Type.Object({
        workerSessionId: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { workerSessionId, reason } = params as {
          workerSessionId: string;
          reason: string;
        };
        await actions.cancel!(workerSessionId, reason);
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text:
                `Cancellation intent recorded for Worker Session ${workerSessionId}; ` +
                "interruption requested without a rollback claim.",
            },
          ],
          details: { workerSessionId },
        };
      },
    });
  }
  return tools;
}

function workerCapabilities(actions: NonNullable<PiTurnRequest["workerActions"]>) {
  return actions.capabilities ?? {
    nativeHarness: "codex" as const,
    effectful: true,
    nativeQuestions: true,
    cancellation: true,
  };
}

function nativeHarnessName(harness: "codex" | "claude" | "copilot"): string {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : "Copilot";
}

function workerCapabilityPrompt(actions: NonNullable<PiTurnRequest["workerActions"]>): string {
  const capabilities = workerCapabilities(actions);
  const nativeName = nativeHarnessName(capabilities.nativeHarness);
  return (
    `\nA proven ${nativeName} Worker capability is available for bounded read-only work.` +
    (capabilities.effectful
      ? " Effectful work is confined to the active Target Project checkout; first record one Commitment with a target-project-operation test criterion, then delegate with checkout-relative targets. CMD Riker runs typed Verification after the Worker finishes."
      : " Effectful assignment is unavailable because Authorized Write Root enforcement is not proven for this Native Harness.") +
    (capabilities.nativeQuestions
      ? " Native questions are available; reserve only authority or product-judgment questions for Owner attention."
      : " Native questions are unavailable.") +
    (capabilities.cancellation ? " Native cancellation is available." : " Native cancellation is unavailable.") +
    (actions.adjudicateReview
      ? " Adjudicate every reported Review finding as must-fix, documented exception, or follow-up with Lead rationale."
      : "") +
    " Never claim resume, deletion, child control, rollback, or effect continuity when the recorded capability facts do not prove it."
  );
}

function toPiModel(
  selection: Extract<ModelSelection, { api: "openai-completions" }>,
): Model<"openai-completions"> {
  return {
    id: selection.model,
    name: selection.model,
    api: selection.api,
    provider: selection.provider,
    baseUrl: selection.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

function toPiMessage(message: ConversationMessage): AgentMessage {
  if (message.role === "owner") {
    return { role: "user", content: message.content, timestamp: message.sequence };
  }
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: message.modelSelection.api,
    provider: message.modelSelection.provider,
    model: message.modelSelection.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: message.sequence,
  };
  return assistant;
}
