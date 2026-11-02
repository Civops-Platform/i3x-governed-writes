// An AI agent asks for a work order to be reprioritised; a planner approves; the
// governor applies it to the CMMS, reads it back, and the ledger holds the story.
// Runs against the synthetic CMMS, so it needs nothing else.
//
//   npx tsx examples/agent-reprioritises.ts

import { CmmsRestAdapter, Governor, Ledger, SystemProjection, startSyntheticCmms, type Principal } from "../src/index";

const cmms = await startSyntheticCmms();
const adapter = new CmmsRestAdapter("cmms", cmms.url);
const projection = new SystemProjection([{ id: "cmms", typeId: "WorkOrder", adapter }]);
await projection.sync();

const ledger = new Ledger(null); // a file path keeps it across restarts
const governor = new Governor({
  ledger: () => ledger,
  site: "example-riverside",
  resolveTarget: (elementId) => projection.resolve(elementId),
  adapters: new Map([["cmms", adapter]]),
  // Normally records in your server's authority namespace; here, one declared inline.
  limits: () => [{ elementId: "limit:maintenance", value: {
    site: "example-riverside", exceptionType: "maintenance-reprioritisation",
    ownerRole: "maintenance-manager", approverRoles: ["maintenance-planner"],
    delegatedLimitUsd: 5000, materialityThresholdUsd: 25000, boundaryTriggers: ["safety"],
  } }],
});

const agent: Principal = { id: "agent:scheduler", kind: "agent" };
const planner: Principal = { id: "planner-1", kind: "person", roles: ["maintenance-planner"] };

const req = await governor.request(agent, {
  idempotencyKey: "reprioritise-WO-1001",
  target: { elementId: "cmms:WO-1001" },
  proposed: { priority: "high" },
  exceptionType: "maintenance-reprioritisation",
  exposureUsd: 2000,
  justification: { decisionRef: "decision:line2-speed-trial" },
});
if (!req.ok) throw new Error(req.detail);
console.log(`${req.id}: ${req.value.status}, approvers ${req.value.authority.approverRoles?.join(" or ")}`);

const agentTry = await governor.decide(agent, req.id, { decision: "approve" });
console.log(`agent approving its own request: ${agentTry.ok ? "allowed?!" : agentTry.detail}`);

const done = await governor.decide(planner, req.id, { decision: "approve", comment: "fits the window" });
if (!done.ok) throw new Error(done.detail);
console.log(`after approval: ${done.value.status}; CMMS priority now ${cmms.orders.get("WO-1001")!.priority}`);
console.log("audit trail:", ledger.history(req.id).map((v) => `${(v.value as { status: string }).status} by ${v.principal}`).join(" → "));
console.log("chain:", (await ledger.verify()) ?? "intact");
await cmms.close();
