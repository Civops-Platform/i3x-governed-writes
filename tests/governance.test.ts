// Governed record writes (W1) against a system of record: the synthetic CMMS over
// real HTTP, a file ledger, the governor driven directly. Synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, SystemProjection, CmmsRestAdapter, systemFolder, verifyChain, type RecordVersion } from "../src/index";
import { readFileSync } from "node:fs";
import { governorFor, people as P, reprioritise, setup } from "./helpers";

const ok = <T extends { ok: boolean }>(r: T) => { assert.equal(r.ok, true, JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
const status = (r: { ok: boolean; status?: number }) => (r.ok ? 200 : r.status);

test("W1 happy path: an agent requests, a planner approves, the CMMS changes, read-back verifies; the ledger is the audit trail", async () => {
  const s = await setup();
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("k1")));
    assert.match(r.id, /^nexus:wr:[0-9a-f]{24}$/);
    assert.equal(r.value.status, "requested");
    assert.equal(r.value.authority.escalation, "stays_local");
    assert.deepEqual([...r.value.authority.approverRoles!].sort(), ["maintenance-manager", "maintenance-planner"]);
    assert.equal(r.value.prior.version, "1");
    assert.equal(r.value.authority.limitRef, "limit:maintenance-reprioritisation");

    // Who may not decide.
    assert.equal(status(await s.gov.decide(P.agent, r.id, { decision: "approve" })), 403, "an agent never approves, whatever roles it holds");
    assert.equal(status(await s.gov.decide(P.reader, r.id, { decision: "approve" })), 403, "no approving role");
    assert.equal(status(await s.gov.decide(P.planner, r.id, { status: "verified" })), 400, "status is computed, never written");

    const d = ok(await s.gov.decide(P.planner, r.id, { decision: "approve", comment: "fits the window" }));
    assert.equal(d.value.status, "verified", d.value.statusDetail ?? "");
    assert.equal(s.cmms.orders.get("WO-1001")!.priority, "high");
    assert.equal(d.value.verification!.match, true);
    assert.deepEqual(s.history(r.id), ["requested", "approved", "applied", "verified"]);
    assert.deepEqual(s.ledger.history(r.id).map((h) => h.principal), ["agent:scheduler", "planner-1", "nexus:governor", "nexus:governor"]);
    assert.equal(await s.ledger.verify(), null, "hash chain intact");
    // Retry with the same key: same request, nothing new.
    const again = ok(await s.gov.request(P.agent, reprioritise("k1")));
    assert.equal(again.id, r.id);
    assert.equal(s.ledger.history(r.id).length, 4);
  } finally { await s.stop(); }
});

test("escalation rule and approver selection", async () => {
  const s = await setup();
  try {
    const cases: Array<[Record<string, unknown>, string, string[] | null, string]> = [
      [{ exposureUsd: 8000 }, "stays_local", ["maintenance-manager"], "above delegated: owner only"],
      [{ exposureUsd: 30000 }, "escalates", ["maintenance-manager"], "at or above materiality"],
      [{ exposureUsd: 100, boundaryTriggers: ["safety"] }, "escalates", ["maintenance-manager"], "a trigger escalates regardless of exposure"],
      [{ exposureUsd: undefined }, "exposure_unknown", ["maintenance-manager"], "no exposure stated"],
      [{ exceptionType: "capex-approval" }, "no_decision_right", null, "no limit for this exception type"],
      [{ reversible: false }, "stays_local", ["plant-manager"], "irreversible: one level above the owner"],
    ];
    for (const [i, [extra, esc, roles, why]] of cases.entries()) {
      const r = ok(await s.gov.request(P.agent, reprioritise(`e${i}`, extra)));
      assert.equal(r.value.authority.escalation, esc, why);
      assert.deepEqual(r.value.authority.approverRoles, roles, why);
      if (!roles) assert.equal(r.value.status, "rejected", why);
    }
    // A planner cannot approve what only the owner may.
    const big = ok(await s.gov.request(P.agent, reprioritise("big", { exposureUsd: 8000 })));
    assert.equal(status(await s.gov.decide(P.planner, big.id, { decision: "approve" })), 403);
    assert.equal(ok(await s.gov.decide(P.manager, big.id, { decision: "approve" })).value.status, "verified");
    // Nobody approves their own request, even holding the role.
    const own = ok(await s.gov.request(P.manager, reprioritise("own")));
    assert.equal(status(await s.gov.decide(P.manager, own.id, { decision: "approve" })), 403);
  } finally { await s.stop(); }
});

test("freshness: a record that moved after the request is not overwritten", async () => {
  const s = await setup();
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("stale")));
    const wo = s.cmms.orders.get("WO-1001")!;
    s.cmms.orders.set("WO-1001", { ...wo, priority: "low", version: wo.version + 1 }); // someone changed it in the CMMS
    const v = ok(await s.gov.decide(P.planner, r.id, { decision: "approve" })).value;
    assert.equal(v.status, "rejected");
    assert.match(v.statusDetail!, /stale/);
    assert.equal(s.cmms.orders.get("WO-1001")!.priority, "low", "the newer value stands");
  } finally { await s.stop(); }
});

test("read-back mismatch: a system that acknowledges but does not apply is caught and compensated", async () => {
  let ignore = false;
  const s = await setup({ ignoreWrites: () => ignore }, { verifyWindowMs: 600 });
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("ghost")));
    ignore = true;
    const v = ok(await s.gov.decide(P.planner, r.id, { decision: "approve" })).value;
    assert.equal(v.status, "rolled_back");
    assert.equal(v.verification!.match, false);
    assert.match(v.statusDetail!, /compensation/);
    assert.deepEqual(s.history(r.id), ["requested", "approved", "applied", "rolled_back"]);
  } finally { await s.stop(); }
});

test("rollback is a new, linked, approved request; an irreversible request has none", async () => {
  const s = await setup();
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("orig")));
    await s.gov.decide(P.planner, r.id, { decision: "approve" });
    assert.equal(s.cmms.orders.get("WO-1001")!.priority, "high");
    const rb = ok(await s.gov.request(P.planner2, { idempotencyKey: "undo-orig", compensates: r.id }));
    assert.deepEqual(rb.value.proposed, { priority: "medium" });
    assert.equal(rb.value.compensates, r.id);
    assert.equal(ok(await s.gov.decide(P.manager, rb.id, { decision: "approve" })).value.status, "verified");
    assert.equal(s.cmms.orders.get("WO-1001")!.priority, "medium");
    // The original stays verified: rollback adds to the record, it erases nothing.
    assert.equal(s.gov.current(r.id)!.status, "verified");

    const irr = ok(await s.gov.request(P.agent, reprioritise("irr", { target: { elementId: "cmms:WO-1002" }, reversible: false })));
    await s.gov.decide(P.plant, irr.id, { decision: "approve" });
    assert.equal(s.gov.current(irr.id)!.status, "verified");
    assert.equal(status(await s.gov.request(P.planner, { idempotencyKey: "undo-irr", compensates: irr.id })), 409);
  } finally { await s.stop(); }
});

test("expiry, a target outside any system of record, and creating a record", async () => {
  let t = Date.parse("2026-11-02T08:00:00Z");
  const s = await setup({}, { expiryMs: 300, now: () => t });
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("slow")));
    t += 400;
    await s.gov.resume();
    assert.equal(s.gov.current(r.id)!.status, "expired");
    assert.equal(status(await s.gov.decide(P.planner, r.id, { decision: "approve" })), 409);
    assert.equal(s.cmms.orders.get("WO-1001")!.priority, "medium", "nothing applied because time ran out");

    assert.equal(status(await s.gov.request(P.agent, reprioritise("x", { target: { elementId: "line2:not-a-record" } }))), 403);
    assert.equal(status(await s.gov.request(P.agent, { ...reprioritise("y"), idempotencyKey: undefined })), 400, "idempotencyKey is required");

    const create = ok(await s.gov.request(P.agent, { idempotencyKey: "new-wo", target: { elementId: systemFolder("cmms") },
      proposed: { asset: "Line 2 filler", title: "Check bowl level sensor", priority: "medium" },
      compensation: { proposed: { status: "cancelled" } }, exceptionType: "maintenance-reprioritisation", exposureUsd: 300 }));
    const v = ok(await s.gov.decide(P.planner, create.id, { decision: "approve" })).value;
    assert.equal(v.status, "verified", v.statusDetail ?? "");
    assert.ok(s.cmms.orders.has(v.target.recordId!));
    assert.equal(status(await s.gov.request(P.agent, { idempotencyKey: "new-wo-2", target: { elementId: systemFolder("cmms") },
      proposed: { title: "x" }, exceptionType: "maintenance-reprioritisation", exposureUsd: 1 })), 400, "creating needs a way to undo it, or reversible: false");
  } finally { await s.stop(); }
});

test("property: whatever the sequence, nothing reaches the CMMS without every check", async () => {
  let rnd = 42;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <X,>(xs: X[]) => xs[Math.floor(rand() * xs.length)];
  const s = await setup();
  const who = [P.planner, P.planner2, P.manager, P.plant, P.agent, P.reader];
  try {
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      const op = rand();
      if (op < 0.4 || !ids.length) {
        // Same draw order as the HTTP version of this test: the body, then who sends it.
        const body = reprioritise(`p${i}`, {
          target: { elementId: pick(["cmms:WO-1001", "cmms:WO-1002"]) }, proposed: { priority: pick(["low", "medium", "high", "urgent"]) },
          exposureUsd: pick([100, 4000, 6000, 30000, undefined]), boundaryTriggers: rand() < 0.15 ? ["safety"] : [],
          exceptionType: rand() < 0.1 ? "unknown-type" : "maintenance-reprioritisation", reversible: rand() > 0.1,
        });
        const r = await s.gov.request(pick(who), body);
        if (r.ok) ids.push(r.id);
      } else if (op < 0.85) {
        const id = pick(ids), decision = rand() < 0.8 ? "approve" : "reject";
        await s.gov.decide(pick(who), id, { decision });
      } else {
        // Interference: someone edits the CMMS directly.
        const id = pick(["WO-1001", "WO-1002"]);
        const wo = s.cmms.orders.get(id)!;
        s.cmms.orders.set(id, { ...wo, assignedTo: `crew-${i}`, version: wo.version + 1 });
      }
    }
    let applied = 0;
    for (const id of ids) {
      const v = s.gov.current(id)!;
      if (!["applied", "verified", "rolled_back"].includes(v.status)) continue;
      applied++;
      const approval = v.approvals.find((a) => a.decision === "approve");
      assert.ok(approval, `${id} applied without an approval`);
      assert.notEqual(approval!.principal, v.actor.principal, `${id} approved by its requester`);
      assert.notEqual(approval!.principal, "agent:scheduler", `${id} approved by an agent`);
      const approver = who.find((p) => p.id === approval!.principal)!;
      assert.ok(v.authority.approverRoles?.includes(approval!.role) && approver.roles!.includes(approval!.role), `${id} approved without the role`);
      assert.deepEqual(s.history(id).slice(0, 3), ["requested", "approved", "applied"], `${id} skipped a state`);
    }
    assert.ok(applied > 3, `the run exercised applies (${applied})`);
    assert.equal(await s.ledger.verify(), null);
    console.log(`# property run: ${ids.length} requests, ${applied} applied, all with valid approvals`);
  } finally { await s.stop(); }
});

test("a governor that dies with an approved request: the next one, on the same ledger file, applies it exactly once", async () => {
  let down = false;
  const s = await setup({ failNext: () => down });
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("ha-1")));
    down = true; // the CMMS fails writes: the approval lands, the apply cannot
    assert.equal(ok(await s.gov.decide(P.planner, r.id, { decision: "approve" })).value.status, "approved");
    // The process dies here. A new one opens the ledger file and resumes.
    down = false;
    const ledger2 = new Ledger(s.file);
    const gov2 = governorFor(ledger2, s.projection, s.adapter);
    await gov2.resume();
    assert.equal(gov2.current(r.id)!.status, "verified");
    assert.equal(s.cmms.orders.get("WO-1001")!.priority, "high");
    assert.equal(s.cmms.orders.get("WO-1001")!.version, 2, "applied exactly once");
    await gov2.resume();
    assert.equal(s.cmms.orders.get("WO-1001")!.version, 2, "a second round changes nothing");
    assert.equal(await ledger2.verify(), null);
  } finally { await s.stop(); }
});

test("a governor that dies after the CMMS applied but before recording it: the next one records it, and does not apply twice", async () => {
  const s = await setup();
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("ha-2")));
    // A ledger that crashes on the "applied" transition: the write reached the CMMS, the record of it did not.
    const crashing = Object.create(s.ledger) as Ledger;
    crashing.write = async (id: string, value: unknown, principal: string, ts?: string, key?: string): Promise<RecordVersion> => {
      if (key?.endsWith(":applied")) throw new Error("process died");
      return s.ledger.write(id, value, principal, ts, key);
    };
    const dying = governorFor(crashing, s.projection, s.adapter);
    await dying.decide(P.planner, r.id, { decision: "approve" }).catch(() => {});
    assert.equal(s.cmms.orders.get("WO-1001")!.version, 2, "the CMMS has the change");
    assert.equal(s.gov.current(r.id)!.status, "approved", "the ledger does not");

    const gov2 = governorFor(new Ledger(s.file), s.projection, s.adapter);
    await gov2.resume();
    assert.equal(gov2.current(r.id)!.status, "verified");
    assert.equal(s.cmms.orders.get("WO-1001")!.version, 2, "not applied a second time");
  } finally { await s.stop(); }
});

test("the ledger is hash-chained: an edited or removed line is detected", async () => {
  const s = await setup();
  try {
    const r = ok(await s.gov.request(P.agent, reprioritise("chain")));
    await s.gov.decide(P.planner, r.id, { decision: "approve" });
    const rows = readFileSync(s.file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RecordVersion);
    assert.equal(verifyChain(rows), null);
    const edited = rows.map((v, i) => (i === 1 ? { ...v, principal: "someone-else" } : v));
    assert.match(verifyChain(edited)!.reason, /edited/);
    assert.match(verifyChain(rows.filter((_, i) => i !== 1))!.reason, /removed or reordered/);
  } finally { await s.stop(); }
});

test("projection: records appear under a folder per system and resolve to their record ids", async () => {
  const s = await setup();
  try {
    const objs = s.projection.objects();
    assert.deepEqual(objs.map((o) => o.id).sort(), ["cmms:WO-1001", "cmms:WO-1002", "nexus:system:cmms"]);
    assert.equal(objs.find((o) => o.id === "cmms:WO-1001")!.name, "Replace capping head bearing");
    assert.deepEqual(s.projection.resolve("cmms:WO-1002"), { system: "cmms", recordId: "WO-1002" });
    assert.equal(s.projection.value("cmms:WO-1001")!.version, "1");
    assert.ok(new SystemProjection([]) && new CmmsRestAdapter("x", "http://127.0.0.1:1"));
  } finally { await s.stop(); }
});
