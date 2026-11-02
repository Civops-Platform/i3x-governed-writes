// A governor wired to the synthetic CMMS, the way an i3X server would wire it.
// Synthetic data only.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmmsRestAdapter, Governor, Ledger, SystemProjection, startSyntheticCmms, type CmmsOptions, type GovernorDeps, type Principal } from "../src/index";

export const SITE = "example-riverside";

export const LIMIT = {
  site: SITE, exceptionType: "maintenance-reprioritisation", ownerRole: "maintenance-manager", aboveOwnerRole: "plant-manager",
  approverRoles: ["maintenance-planner"], delegatedLimitUsd: 5000, materialityThresholdUsd: 25000, boundaryTriggers: ["safety"],
};

export const people: Record<string, Principal> = {
  planner: { id: "planner-1", kind: "person", roles: ["maintenance-planner"] },
  planner2: { id: "planner-2", kind: "person", roles: ["maintenance-planner"] },
  manager: { id: "manager-1", kind: "person", roles: ["maintenance-manager"] },
  plant: { id: "plant-1", kind: "person", roles: ["plant-manager"] },
  agent: { id: "agent:scheduler", kind: "agent", roles: ["maintenance-manager"] }, // holds the role, still may not approve
  reader: { id: "reader", kind: "person", roles: [] },
};

export const reprioritise = (key: string, extra: Record<string, unknown> = {}) => ({
  idempotencyKey: key, target: { elementId: "cmms:WO-1001" }, proposed: { priority: "high" },
  exceptionType: "maintenance-reprioritisation", exposureUsd: 2000,
  justification: { decisionRef: "decision:line2-speed-trial", falsification: { metric: "unplanned-downtime-min", target: "< 30", deadline: "2026-11-30T00:00:00Z" } },
  ...extra,
});

export function governorFor(ledger: Ledger, projection: SystemProjection, adapter: CmmsRestAdapter, over: Partial<GovernorDeps> = {}) {
  return new Governor({
    ledger: () => ledger, site: SITE,
    resolveTarget: (id) => projection.resolve(id),
    adapters: new Map([["cmms", adapter]]),
    limits: () => [{ elementId: "limit:maintenance-reprioritisation", value: LIMIT }],
    verifyWindowMs: 1_000,
    ...over,
  });
}

export async function setup(cmmsOpts: CmmsOptions = {}, over: Partial<GovernorDeps> = {}) {
  const cmms = await startSyntheticCmms(0, cmmsOpts);
  const dir = mkdtempSync(join(tmpdir(), "governed-writes-"));
  const file = join(dir, "ledger.jsonl");
  const ledger = new Ledger(file);
  const adapter = new CmmsRestAdapter("cmms", cmms.url);
  const projection = new SystemProjection([{ id: "cmms", typeId: "WorkOrder", name: "Synthetic CMMS", adapter }]);
  await projection.sync();
  const gov = governorFor(ledger, projection, adapter, over);
  const history = (id: string) => ledger.history(id).map((h) => (h.value as { status: string }).status);
  const stop = async () => { await cmms.close(); rmSync(dir, { recursive: true, force: true }); };
  return { cmms, ledger, file, adapter, projection, gov, history, stop };
}
