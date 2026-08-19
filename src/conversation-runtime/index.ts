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
    accept(commitmentId: string): void;
    resume(commitmentId: string): void;
    control(
      commitmentId: string,
      action: "pause" | "cancel" | "supersede",
      reason: string,
      replacementCommitmentId?: string,
    ): void;
    executeOperation(commitmentId: string, operation: "test"): Promise<TargetProjectOperationResult>;
  };
  workers?: readonly WorkerSession[];
  workerQuestions?: readonly WorkerQuestion[];
  workerActions?: {
    delegate(input: {
      objective: string;
      prompt: string;
      commitmentId?: string;
    }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
    delegateEffectful(input: {
      objective: string;
      prompt: string;
      commitmentId: string;
      targets: string[];
    }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
    answer(questionId: string, answers: Record<string, string[]>): Promise<void>;
    cancel(workerSessionId: string, reason: string): Promise<void>;
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
           (request.workerActions
              ? "\nA proven Codex 0.147.0 Worker capability is available for network-disabled read-only work and " +
                "effectful work confined to the active Target Project checkout. For implementation, first record " +
                "one Commitment with a target-project-operation test criterion, then call delegate_effectful_codex " +
                "with checkout-relative targets. CMD Riker runs typed Verification after the Worker finishes. " +
                "It supports native questions and cancellation. Never claim rollback or effectful replay after connection loss."
             : "") +
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
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId, operation } = params as {
          commitmentId: string;
          operation: "test";
        };
        const result = await actions.executeOperation(commitmentId, operation);
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

function workerTools(
  request: PiTurnRequest,
  observer: { onMutation(): void },
): AgentTool[] {
  if (!request.workerActions) return [];
  const actions = request.workerActions;
  return [
    {
      name: "delegate_read_only_codex",
      label: "Delegate Read-only Codex Worker",
      description:
        "Start one bounded, network-disabled, read-only Codex Worker Session without waiting for its outcome.",
      parameters: Type.Object({
        objective: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
        commitmentId: Type.Optional(Type.String({ minLength: 1 })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const result = await actions.delegate(
          params as { objective: string; prompt: string; commitmentId?: string },
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
    {
      name: "delegate_effectful_codex",
      label: "Delegate Effectful Codex Worker",
      description:
        "Start one bounded, network-disabled Codex implementation assignment inside the technically enforced active Target Project checkout. Requires an active Commitment with declared test Verification.",
      parameters: Type.Object({
        objective: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
        commitmentId: Type.String({ minLength: 1 }),
        targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const result = await actions.delegateEffectful(
          params as {
            objective: string;
            prompt: string;
            commitmentId: string;
            targets: string[];
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
    },
    {
      name: "answer_worker_question",
      label: "Answer Worker Question",
      description: "Deliver the Owner's answer to one open native Codex question by durable identity.",
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
        await actions.answer(questionId, answers);
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
    },
    {
      name: "cancel_worker_session",
      label: "Cancel Worker Session",
      description:
        "Record cancellation intent, then interrupt one active Codex Worker Session. This does not roll back effects.",
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
        await actions.cancel(workerSessionId, reason);
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
    },
  ];
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
