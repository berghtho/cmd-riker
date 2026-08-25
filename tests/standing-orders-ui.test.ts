import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  parseStandingOrderControl,
  projectSessionView,
  projectStandingOrders,
  renderStandingOrderDetail,
  renderStandingOrders,
} from "../src/session-view/index.ts";
import type { StandingOrder } from "../src/orchestration-core/index.ts";

function order(id: string, overrides: Partial<StandingOrder> = {}): StandingOrder {
  return {
    id,
    title: "Merge verified changes",
    instruction: "Merge verified changes to main while I am away.",
    commitmentIds: ["commitment-1"],
    effectClasses: ["merge"],
    targets: ["github.com/owner/repository"],
    allowIrreversibleEffects: false,
    allowExternallyBindingEffects: false,
    maximumIncrementalSpendUsd: 0,
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    createdByOwnerTurnId: "turn-1",
    ownerInstructionQuote: "Merge verified changes to main while I am away.",
    state: "active",
    ...overrides,
  } as StandingOrder;
}

test("Standing Orders project with derived expiry and render without identifiers", () => {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const entries = projectStandingOrders([
    order("11111111-aaaa-bbbb-cccc-dddddddddddd", {
      title: "Old authority",
      validUntil: expiredAt,
    }),
    order("22222222-aaaa-bbbb-cccc-dddddddddddd"),
    order("33333333-aaaa-bbbb-cccc-dddddddddddd", {
      title: "Withdrawn authority",
      state: "revoked",
      revocation: { ownerTurnId: "turn-2", reason: "No longer needed.", revokedAt: expiredAt },
    }),
  ]);

  // Current authority first; lapsed and withdrawn authority stay inspectable.
  assert.deepEqual(
    entries.map((entry) => [entry.number, entry.status]),
    [
      [1, "active"],
      [2, "expired"],
      [3, "revoked"],
    ],
  );

  const rendered = [
    renderStandingOrders(entries),
    ...entries.map(renderStandingOrderDetail),
  ].join("\n");
  assert.doesNotMatch(rendered, /[0-9a-f]{8}-[0-9a-f]{4}/i);
  assert.match(rendered, /EXPIRED/);
  assert.match(rendered, /No longer needed\./);
  assert.match(rendered, /\/session revoke-order 1 /);
});

test("Standing Order controls resolve numbers and refuse revoking inactive orders", () => {
  const entries = projectStandingOrders([
    order("11111111-aaaa-bbbb-cccc-dddddddddddd"),
    order("22222222-aaaa-bbbb-cccc-dddddddddddd", {
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    }),
  ]);

  const detail = parseStandingOrderControl(entries, "/session order 2");
  assert.equal(detail?.kind, "show-order");

  const revoke = parseStandingOrderControl(entries, "/session revoke-order 1 done with it");
  assert.deepEqual(revoke, {
    kind: "revoke-order",
    standingOrderId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
    reason: "done with it",
  });

  // The expired order is number 2 and no longer grants anything to revoke.
  assert.equal(parseStandingOrderControl(entries, "/session revoke-order 2 stale"), undefined);
  assert.equal(parseStandingOrderControl(entries, "/session revoke-order 9 typo"), undefined);
  assert.equal(parseStandingOrderControl(entries, "/session revoke-order 1"), undefined);
});

test("the Session View snapshot lists Standing Orders and flags lapsed authority", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-orders-view-test-"));
  const state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  });
  state.appendStandingOrderSnapshots([
    order("44444444-aaaa-bbbb-cccc-dddddddddddd", {
      title: "Lapsed authority",
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    }),
  ]);
  state.appendStandingOrderSnapshots([order("55555555-aaaa-bbbb-cccc-dddddddddddd")]);

  const snapshot = projectSessionView(state);
  assert.equal(snapshot.standingOrders?.length, 2);
  assert.equal(snapshot.standingOrders?.[0]?.status, "active");
  assert.ok(
    snapshot.notices.some((notice) => notice.includes('"Lapsed authority" has expired')),
  );
});
