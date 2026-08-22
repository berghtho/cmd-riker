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
import {
  createCodingTools,
  createFindTool,
  createGrepTool,
  createLsTool,
  formatSkillsForPrompt,
  getAgentDir,
  loadProjectContextFiles,
  loadSkills,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  Commitment,
  CommitmentDraft,
  ConversationMessage,
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
import type { ForgeOperationResult } from "../forge-operations/index.ts";

export type PiTurnRequest = {
  conversation: readonly ConversationMessage[];
  ownerInput: string;
  modelSelection: ModelSelection;
  commitments?: readonly Commitment[];
  commitmentActions?: {
    resume(commitmentId: string): void;
    cancel(commitmentId: string, reason: string): void;
    executeOperation(
      commitmentId: string | undefined,
      operation: "test",
    ): Promise<TargetProjectOperationResult>;
  };
  forgeActions?: {
    commentOnGitHubIssue?(
      input: { commitmentId?: string; issueNumber: number; body: string },
    ): Promise<ForgeOperationResult>;
    closeGitHubIssue?(
      input: {
        commitmentId?: string;
        issueNumber: number;
        stateReason?: "completed" | "not-planned";
      },
    ): Promise<ForgeOperationResult>;
    removeGitHubIssueLabel?(
      input: { commitmentId?: string; issueNumber: number; label: string },
    ): Promise<ForgeOperationResult>;
    inspectAzureSubscription?(commitmentId?: string): Promise<ForgeOperationResult>;
  };
  standingOrders?: readonly StandingOrder[];
  authorityActions?: {
    recordStandingOrder(draft: StandingOrderDraft): StandingOrder;
    revokeStandingOrder(standingOrderId: string, reason: string): void;
  };
  /** Grants the Lead its full native tool belt (read, bash, edit, write, grep,
   * find, ls) rooted in the Target Project, plus installed skills and project
   * context files in its system prompt. */
  nativeTools?: {
    cwd: string;
  };
  harnessActions?: {
    configure(input: {
      harness: "codex" | "claude" | "copilot";
      enabled?: boolean;
      model?: string;
    }): { harness: string; enabled: boolean; model?: string };
  };
  workers?: readonly WorkerSession[];
  workerQuestions?: readonly WorkerQuestion[];
  workerUnavailability?: {
    nativeHarness: "codex" | "claude" | "copilot";
    detail: string;
  };
  workerActions?: {
    harnesses: Array<{
      nativeHarness: "codex" | "claude" | "copilot";
      effectful: boolean;
      nativeQuestions: boolean;
      cancellation: boolean;
      delegate(input: {
        objective: string;
        prompt: string;
        model?: string;
        commitmentId?: string;
        recoveryOfWorkerSessionId?: string;
        recoveryReason?: string;
      }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
      delegateEffectful?(input: {
        objective: string;
        prompt: string;
        model?: string;
        commitmentId?: string;
        targets: string[];
        timeoutMinutes?: number;
        recoveryOfWorkerSessionId?: string;
        recoveryReason?: string;
      }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
    }>;
    delegateReview?(input: {
      implementationWorkerSessionId: string;
      prompt: string;
      harness?: "codex" | "claude" | "copilot";
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
    steer?(workerSessionId: string, message: string): Promise<void>;
    workerOutput?(workerSessionId: string): string | undefined;
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
        ...forgeTools(request, mutationObserver),
        ...authorityTools(request, mutationObserver),
        ...workerTools(request, mutationObserver),
        ...harnessTools(request, mutationObserver),
        ...(request.nativeTools ? leadNativeTools(request.nativeTools.cwd) : []),
      ];
      const nativeContext = request.nativeTools
        ? loadNativeContext(request.nativeTools.cwd)
        : { skillsPrompt: "", contextFilesPrompt: "" };
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
      const initialState = {
        systemPrompt:
          "You are CMD Riker's Lead Agent: confident, composed, warm, observant, decisive, candid, " +
          "occasionally witty, proactive, and loyal to the Owner's intent without becoming passive. " +
          "Enjoy the work, challenge weak plans professionally, and serve the Owner without theatrical role-play. " +
          "You hold full Command Authority within the mission and Standing Orders, whether the Owner is " +
          "present or absent; absence changes only your reporting duty — report decisions, effects, and open " +
          "points when the Owner returns. Take the reversible variant of any irreversible action that lacks " +
          "explicit coverage." +
          " Act on the Owner's intent immediately: a plain imperative like 'start', 'fix it', or 'go ahead' is " +
          "sufficient authority to begin the obvious next unit of work. Split a feature into parallel Worker " +
          "assignments yourself, pick the harness per task, and fill routine parameters from the conversation " +
          "and durable state. Never ask the Owner for internal IDs, forms, or restatements of what they already " +
          "said; if exactly one genuine product decision is missing, propose a concrete default and ask one " +
          "short question. Use resume_work_item for blocked work the Owner asks to continue and " +
          "cancel_work_item only on their explicit instruction." +
          " When the Owner asks how things stand, answer in their language and in plain terms: name each " +
          "work item by what it is, say what is happening right now, and say what (if anything) you need from " +
          "them. Keep UUIDs and state-machine vocabulary out of everything the Owner sees." +
          " Deliver with evidence: run run_target_project_operation for durable Verification, then report what " +
          "shipped, the evidence, decisions taken, and open points — delivery needs no Owner acceptance." +
          " Your turn is the only moment you act: after your reply, nothing continues except dispatched Worker " +
          "Sessions. Never tell the Owner you are checking, continuing, or working on something unless a Worker " +
          "Session is actually running on it — when work must continue, delegate the Worker within this turn and " +
          "name it in your reply, and otherwise state plainly that you are standing by." +
          (request.harnessActions
            ? " The Owner configures Worker harnesses conversationally: when they ask to enable, disable, or " +
              "change the model of a harness, call configure_worker_harness yourself — never send them to a " +
              "configuration file."
            : "") +
          (request.nativeTools
            ? " You hold your full native tool belt (read, bash, edit, write, grep, find, ls) rooted in the " +
              "Target Project. Act directly whenever that serves the mission best; delegating to a Worker " +
              "Session is one option, never a prerequisite. When you edit files inside a running Worker's " +
              "checkout, announce the change to that Worker before it continues, so it never reacts to " +
              "unexplained changes."
            : "") +
           (request.forgeActions?.commentOnGitHubIssue || request.forgeActions?.closeGitHubIssue ||
             request.forgeActions?.removeGitHubIssueLabel || request.forgeActions?.inspectAzureSubscription
             ? " Use the typed GitHub and Azure tools only for their declared semantic operations; never construct gh or az commands. " +
               "Treat an unavailable result as one Owner action and do not retry blindly."
             : "") +
           (commitmentContext ? `\nCurrent Work Items:\n${commitmentContext}` : "") +
           (request.authorityActions
             ? "\nStanding Orders are plain-language durable Owner instructions that grant, reserve, or limit " +
               "authority. When the Owner grants one, summarize the bounds you understood in your response and " +
               "record it from their words; quote the Owner's own sentence."
             : "") +
           (standingOrderContext ? `\nStanding Orders:\n${standingOrderContext}` : "") +
           nativeContext.skillsPrompt +
           nativeContext.contextFilesPrompt +
           (request.workerActions ? workerCapabilityPrompt(request.workerActions) : "") +
           (!request.workerActions && request.workerUnavailability
             ? `\nNo ${nativeHarnessName(request.workerUnavailability.nativeHarness)} Worker capability is ` +
               `available right now: ${request.workerUnavailability.detail} ` +
               "Tell the Owner plainly what is unavailable and what would restore it; never pretend delegation happened."
             : "") +
           (workerContext ? `\nCurrent Worker Sessions:\n${workerContext}` : "") +
           (questionContext ? `\nOpen Worker questions:\n${questionContext}` : ""),
        model: execution.model,
        messages: request.conversation.map(toPiMessage),
        tools,
        // The Lead carries Command Authority; without an Owner-chosen level,
        // reasoning models get the full thinking budget. Loopback completions
        // models advertise no reasoning support.
        ...(request.modelSelection.api === "openai-codex-responses"
          ? { thinkingLevel: request.modelSelection.thinkingLevel ?? ("xhigh" as const) }
          : {}),
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

function forgeTools(
  request: PiTurnRequest,
  observer: { onMutation(): void },
): AgentTool[] {
  if (!request.forgeActions) return [];
  const actions = request.forgeActions;
  const tools: AgentTool[] = [];
  if (actions.commentOnGitHubIssue) tools.push({
      name: "comment_on_github_issue",
      label: "Comment on GitHub Issue",
      description:
        "Create one bounded GitHub issue comment through the typed adapter, after proving executable, authentication, intended account, repository, and write capability. The durable result is settled only by remote read-back.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
        issueNumber: Type.Integer({ minimum: 1 }),
        body: Type.String({ minLength: 1, maxLength: 65_536 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId, issueNumber, body } = params as {
          commitmentId: string;
          issueNumber: number;
          body: string;
        };
        const result = await actions.commentOnGitHubIssue!(
          { commitmentId, issueNumber, body },
        );
        observer.onMutation();
        return {
          content: [{ type: "text", text: forgeResultText(result) }],
          details: result,
        };
      },
    });
  if (actions.closeGitHubIssue) tools.push({
      name: "close_github_issue",
      label: "Close GitHub Issue",
      description:
        "Close one GitHub issue through the typed adapter, after proving executable, authentication, intended account, repository, and write capability. The durable result is settled only by remote read-back of the closed state. Close an issue only after its durable resolution comment exists.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
        issueNumber: Type.Integer({ minimum: 1 }),
        stateReason: Type.Optional(Type.Union([
          Type.Literal("completed"),
          Type.Literal("not-planned"),
        ])),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId, issueNumber, stateReason } = params as {
          commitmentId: string;
          issueNumber: number;
          stateReason?: "completed" | "not-planned";
        };
        const result = await actions.closeGitHubIssue!({
          commitmentId,
          issueNumber,
          ...(stateReason ? { stateReason } : {}),
        });
        observer.onMutation();
        return {
          content: [{ type: "text", text: forgeResultText(result) }],
          details: result,
        };
      },
    });
  if (actions.removeGitHubIssueLabel) tools.push({
      name: "remove_github_issue_label",
      label: "Remove GitHub Issue Label",
      description:
        "Remove one label from one GitHub issue through the typed adapter, after proving executable, authentication, intended account, repository, and write capability. The durable result is settled only by remote read-back of the issue's labels.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
        issueNumber: Type.Integer({ minimum: 1 }),
        label: Type.String({ minLength: 1, maxLength: 100 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId, issueNumber, label } = params as {
          commitmentId: string;
          issueNumber: number;
          label: string;
        };
        const result = await actions.removeGitHubIssueLabel!({ commitmentId, issueNumber, label });
        observer.onMutation();
        return {
          content: [{ type: "text", text: forgeResultText(result) }],
          details: result,
        };
      },
    });
  if (actions.inspectAzureSubscription) tools.push({
      name: "inspect_azure_subscription",
      label: "Inspect Azure Subscription",
      description:
        "Inspect one Azure subscription through the typed non-interactive adapter after proving executable, intended account, target, and read capability. No secret value is accepted or returned.",
      parameters: Type.Object({
        commitmentId: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { commitmentId } = params as { commitmentId: string };
        const result = await actions.inspectAzureSubscription!(commitmentId);
        observer.onMutation();
        return {
          content: [{ type: "text", text: forgeResultText(result) }],
          details: result,
        };
      },
    });
  return tools;
}

function forgeResultText(result: ForgeOperationResult): string {
  const base = `${result.provider} operation attempt ${result.operationAttemptId} ended ${result.status}.`;
  return result.ownerAction
    ? `${base} Owner action: ${result.ownerAction.nextAction}`
    : result.uncertainty
      ? `${base} ${result.uncertainty.reason}`
      : `${base} ${result.evidence.length} attributed evidence item(s).`;
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
  Type.Object({
    kind: Type.Literal("forge-operation"),
    description: Type.String({ minLength: 1 }),
    operation: Type.Union([
      Type.Literal("github-issue-comment"),
      Type.Literal("github-issue-close"),
      Type.Literal("github-issue-label-remove"),
      Type.Literal("azure-subscription-inspection"),
    ]),
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
      name: "run_target_project_operation",
      label: "Run Target Project Operation",
      description:
        "Run one declared semantic Target Project operation for durable Verification evidence. " +
        "When workItemId is omitted, CMD Riker attaches the run to a fresh Work Item.",
      parameters: Type.Object({
        workItemId: Type.Optional(Type.String({ minLength: 1 })),
        operation: Type.Literal("test"),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { workItemId, operation } = params as {
          workItemId?: string;
          operation: "test";
        };
        const result = await actions.executeOperation(workItemId, operation);
        observer.onMutation();
        return {
          content: [
            {
              type: "text",
              text:
                `Operation ended ${result.status}; ` +
                `${result.affectedArtifacts.length} affected artifact(s); ` +
                `${result.uncertainty ? result.uncertainty.reason : "no unresolved uncertainty"}.`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: "resume_work_item",
      label: "Resume Work Item",
      description: "Continue a blocked Work Item the Owner asked to pick back up.",
      parameters: Type.Object({ workItemId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { workItemId } = params as { workItemId: string };
        actions.resume(workItemId);
        observer.onMutation();
        return {
          content: [{ type: "text", text: "The Work Item is active again." }],
          details: { workItemId, state: "active" },
        };
      },
    },
    {
      name: "cancel_work_item",
      label: "Cancel Work Item",
      description: "Cancel one Work Item on the Owner's explicit instruction.",
      parameters: Type.Object({
        workItemId: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { workItemId, reason } = params as { workItemId: string; reason: string };
        actions.cancel(workItemId, reason);
        observer.onMutation();
        return {
          content: [{ type: "text", text: "The Work Item is cancelled." }],
          details: { workItemId, state: "cancelled" },
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
        ownerInstructionQuote: Type.String({ minLength: 2 }),
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
  ];
}

function harnessTools(
  request: PiTurnRequest,
  observer: { onMutation(): void },
): AgentTool[] {
  const actions = request.harnessActions;
  if (!actions) return [];
  return [
    {
      name: "configure_worker_harness",
      label: "Configure Worker Harness",
      description:
        "Persist the Owner's Native Harness preference: enable or disable a harness, or set its Worker model. " +
        "Model changes apply from the next delegation; activating a different harness applies after the next start.",
      parameters: Type.Object({
        harness: Type.Union([
          Type.Literal("codex"),
          Type.Literal("claude"),
          Type.Literal("copilot"),
        ]),
        enabled: Type.Optional(Type.Boolean()),
        model: Type.Optional(Type.String({ minLength: 1 })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const setting = actions.configure(params as {
          harness: "codex" | "claude" | "copilot";
          enabled?: boolean;
          model?: string;
        });
        observer.onMutation();
        return {
          content: [{
            type: "text",
            text:
              `Harness ${setting.harness} is now ${setting.enabled ? "enabled" : "disabled"}` +
              (setting.model ? ` with Worker model ${setting.model}.` : "."),
          }],
          details: setting,
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
  const tools: AgentTool[] = [];
  for (const harness of actions.harnesses) {
    const nativeName = nativeHarnessName(harness.nativeHarness);
    tools.push({
      name: `delegate_read_only_${harness.nativeHarness}`,
      label: `Delegate Read-only ${nativeName} Worker`,
      description:
        `Start one bounded, read-only ${nativeName} Worker Session without waiting for its outcome. ` +
        "Pass model only to override the configured Worker model for this task.",
      parameters: Type.Object({
        objective: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
        model: Type.Optional(Type.String({ minLength: 1 })),
        commitmentId: Type.Optional(Type.String({ minLength: 1 })),
        recoveryOfWorkerSessionId: Type.Optional(Type.String({ minLength: 1 })),
        recoveryReason: Type.Optional(Type.String({ minLength: 1 })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const result = await harness.delegate(
          params as {
            objective: string;
            prompt: string;
            model?: string;
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
    });
    const delegateEffectful = harness.delegateEffectful;
    if (harness.effectful && delegateEffectful) {
      tools.push({
        name: `delegate_effectful_${harness.nativeHarness}`,
        label: `Delegate Effectful ${nativeName} Worker`,
        description:
          `Start one bounded ${nativeName} implementation assignment inside the technically enforced active Target Project checkout. ` +
          "When commitmentId is omitted, CMD Riker records the covering Work Item with its test Verification automatically. " +
          "Pass model or timeoutMinutes only to override the defaults for this task.",
        parameters: Type.Object({
          objective: Type.String({ minLength: 1 }),
          prompt: Type.String({ minLength: 1 }),
          model: Type.Optional(Type.String({ minLength: 1 })),
          commitmentId: Type.Optional(Type.String({ minLength: 1 })),
          targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
          timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 180 })),
          recoveryOfWorkerSessionId: Type.Optional(Type.String({ minLength: 1 })),
          recoveryReason: Type.Optional(Type.String({ minLength: 1 })),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const result = await delegateEffectful(
            params as {
              objective: string;
              prompt: string;
              model?: string;
              commitmentId?: string;
              targets: string[];
              timeoutMinutes?: number;
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
                  `Worker Session ${result.workerSessionId} started effectful ` +
                  `execution attempt ${result.executionAttemptId} inside its Authorized Write Root.`,
              },
            ],
            details: result,
          };
        },
      });
    }
  }
  if (actions.steer) {
    tools.push({
      name: "steer_worker",
      label: "Steer Worker",
      description:
        "Send a mid-run Lead message into a live Worker Session: correct its course, deliver another Worker's finding, " +
        "or announce a direct edit you made inside its checkout before it continues.",
      parameters: Type.Object({
        workerSessionId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { workerSessionId, message } = params as {
          workerSessionId: string;
          message: string;
        };
        await actions.steer!(workerSessionId, message);
        observer.onMutation();
        return {
          content: [{ type: "text", text: "The steering message was delivered to the Worker." }],
          details: { workerSessionId },
        };
      },
    });
  }
  if (actions.workerOutput) {
    tools.push({
      name: "read_worker_output",
      label: "Read Worker Output",
      description: "Read the live output tail of one running Worker Session.",
      parameters: Type.Object({ workerSessionId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const { workerSessionId } = params as { workerSessionId: string };
        const output = actions.workerOutput!(workerSessionId);
        return {
          content: [{
            type: "text",
            text: output?.trim() ? output : "The Worker has produced no output yet.",
          }],
          details: { workerSessionId },
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
        harness: Type.Optional(Type.Union([
          Type.Literal("codex"),
          Type.Literal("claude"),
          Type.Literal("copilot"),
        ])),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const result = await actions.delegateReview!(params as {
          implementationWorkerSessionId: string;
          prompt: string;
          harness?: "codex" | "claude" | "copilot";
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
  const anyNativeQuestions = actions.harnesses.some((harness) => harness.nativeQuestions);
  const anyCancellation = actions.harnesses.some((harness) => harness.cancellation);
  if (anyNativeQuestions && actions.answer) {
    tools.push({
      name: "answer_worker_question",
      label: "Answer Worker Question",
      description: "Deliver the decided answer to one open native Worker question by durable identity.",
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
  if (anyNativeQuestions && actions.reserveOwnerDecision) {
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
  if (anyCancellation && actions.cancel) {
    tools.push({
      name: "cancel_worker_session",
      label: "Cancel Worker Session",
      description:
        "Record cancellation intent, then interrupt one active Worker Session. This does not roll back effects.",
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

function nativeHarnessName(harness: "codex" | "claude" | "copilot"): string {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : "Copilot";
}

function workerCapabilityPrompt(actions: NonNullable<PiTurnRequest["workerActions"]>): string {
  const roster = actions.harnesses
    .map(
      (harness) =>
        `${nativeHarnessName(harness.nativeHarness)} (${harness.effectful ? "implements and reviews" : "read-only research and review"})`,
    )
    .join(", ");
  return (
    `\nAvailable Worker harnesses: ${roster}. You choose the harness and, when useful, the model per ` +
    "task — split one feature across parallel Workers freely; the Owner never sees the choice but can " +
    "override it in plain language. Effectful work is confined to isolated checkouts with " +
    "checkout-relative targets; when you omit commitmentId, CMD Riker records the covering Work Item " +
    "and its test Verification automatically. CMD Riker runs typed Verification after a Worker finishes." +
    (actions.steer
      ? " You have live visibility (read_worker_output) and can steer any running Worker mid-run " +
        "(steer_worker): correct a wrong path, deliver one Worker's finding to another, and always " +
        "announce your own direct edits inside a Worker's checkout before it continues."
      : "") +
    (actions.adjudicateReview
      ? " Adjudicate every reported Review finding as must-fix, documented exception, or follow-up with Lead rationale."
      : "") +
    " Answer routine Worker questions yourself within the mission; reserve only genuine product " +
    "decisions for the Owner. Never claim resume, deletion, child control, rollback, or effect " +
    "continuity when the recorded capability facts do not prove it."
  );
}

function leadNativeTools(cwd: string): AgentTool[] {
  return [
    ...createCodingTools(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

const maximumContextFilePromptChars = 24_000;

function loadNativeContext(cwd: string): {
  skillsPrompt: string;
  contextFilesPrompt: string;
} {
  let skillsPrompt = "";
  try {
    const skills = loadSkills({
      cwd,
      agentDir: getAgentDir(),
      skillPaths: [],
      includeDefaults: true,
    }).skills;
    if (skills.length > 0) {
      skillsPrompt =
        "\nInstalled skills are available; read a skill's file with your read tool when you use it.\n" +
        formatSkillsForPrompt(skills);
    }
  } catch {
    // Skills stay optional; a discovery failure never blocks the Lead turn.
  }
  let contextFilesPrompt = "";
  try {
    let remaining = maximumContextFilePromptChars;
    const sections: string[] = [];
    for (const file of loadProjectContextFiles({ cwd, agentDir: getAgentDir() })) {
      if (remaining <= 0) break;
      const content = file.content.slice(0, remaining);
      remaining -= content.length;
      sections.push(`\nContext file ${file.path}:\n${content}`);
    }
    contextFilesPrompt = sections.join("");
  } catch {
    // Context files stay optional; a discovery failure never blocks the Lead turn.
  }
  return { skillsPrompt, contextFilesPrompt };
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
    contextWindow: 131_072,
    maxTokens: 16_384,
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
