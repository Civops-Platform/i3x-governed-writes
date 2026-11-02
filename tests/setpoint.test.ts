// Governed setpoint writes (W2) against an in-memory device that behaves like the
// three kinds of tag that matter: one that applies a write, one that acknowledges
// and ignores it, and one that refuses it. Synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Governor, Ledger, SetpointAdapter, envelopeViolation, SETPOINT_SYSTEM, type Principal, type SetpointPoint } from "../src/index";

const people: Record<string, Principal> = {
  operator: { id: "operator-1", kind: "person", roles: ["shift-supervisor"] },
  agent: { id: "agent:optimizer", kind: "agent" },
  service: { id: "svc:scheduler", kind: "service", roles: ["shift-supervisor"] },
};

function setup() {
  // The device, and the server's view of it (value + quality, as a last-value cache holds it).
  const plant = { temp: 62, ghost: 50, locked: 10 };
  const quality = { temp: "Good", ghost: "Good", locked: "Good" } as Record<keyof typeof plant, string>;
  const point = (name: keyof typeof plant, envelope: SetpointPoint["envelope"], behaviour: "applies" | "ignores" | "refuses"): SetpointPoint => ({
    envelope,
    read: () => ({ value: plant[name], quality: quality[name] }),
    write: async (v) => {
      if (behaviour === "refuses") return { ok: false, detail: "BadNotWritable", permanent: true };
      if (behaviour === "applies") plant[name] = v as number;
      return { ok: true };
    },
  });
  const sp = new SetpointAdapter(new Map([
    ["sp:temp/value", point("temp", { min: 55, max: 70, maxStep: 3 }, "applies")],
    ["sp:ghost/value", point("ghost", { min: 0, max: 100, maxStep: 50 }, "ignores")],
    ["sp:locked/value", point("locked", { min: 0, max: 100, maxStep: 50 }, "refuses")],
  ]));
  let suspended: string | null = null;
  const ledger = new Ledger(null);
  const gov = new Governor({
    ledger: () => ledger, site: "example-riverside",
    resolveTarget: () => null,
    resolveSetpoint: (id, field) => (sp.has(`${id}/${field}`) ? { system: SETPOINT_SYSTEM, recordId: `${id}/${field}` } : null),
    envelopeCheck: (attr, proposed, current) => envelopeViolation(sp.envelopeOf(attr) ?? {}, proposed, current),
    w2Suspended: () => suspended,
    adapters: new Map([[SETPOINT_SYSTEM, sp]]),
    limits: () => [{ elementId: "limit:setpoint", value: { site: "example-riverside", exceptionType: "setpoint-change",
      ownerRole: "shift-supervisor", aboveOwnerRole: "plant-manager", approverRoles: ["shift-supervisor"], delegatedLimitUsd: 1e9, materialityThresholdUsd: 1e9, boundaryTriggers: [] } }],
    verifyWindowMs: 300,
  });
  const req = (elementId: string, v: unknown, key: string, p = people.agent) =>
    gov.request(p, { idempotencyKey: key, target: { elementId }, proposed: { value: v }, exceptionType: "setpoint-change" }, "W2");
  const idOf = (r: Awaited<ReturnType<typeof req>>) => { assert.ok(r.ok, JSON.stringify(r)); return (r as { id: string }).id; };
  return { plant, quality, gov, ledger, req, idOf, suspend: (why: string | null) => { suspended = why; } };
}

test("envelope check is exact: range, step from the current value, allowed states", () => {
  const e = { min: 55, max: 70, maxStep: 3 };
  assert.equal(envelopeViolation(e, 64, 62), null);
  assert.equal(envelopeViolation(e, 65, 62), null, "a step of exactly maxStep is allowed");
  assert.match(envelopeViolation(e, 71, 69)!, /maximum/);
  assert.match(envelopeViolation(e, 54, 55)!, /minimum/);
  assert.match(envelopeViolation(e, 66, 62)!, /step/);
  assert.match(envelopeViolation(e, "64" as never, 62)!, /finite number/);
  assert.match(envelopeViolation(e, NaN, 62)!, /finite/);
  assert.match(envelopeViolation(e, 63, null)!, /current value is not a number/);
  assert.equal(envelopeViolation({ allowed: ["Run", "Hold"] }, "Hold", "Run"), null);
  assert.match(envelopeViolation({ allowed: ["Run", "Hold"] }, "Stop", "Run")!, /one of/);
});

test("W2: a person approves, the write lands, read-back verifies; agents and services never approve", async () => {
  const s = setup();
  const id = s.idOf(await s.req("sp:temp", 64.5, "k1"));
  const v0 = s.gov.current(id)!;
  assert.equal(v0.tier, "W2");
  assert.ok(Date.parse(v0.expiresAt) - Date.now() <= 15 * 60_000 + 1000, "W2 expires in 15 minutes");
  const a = await s.gov.decide(people.agent, id, { decision: "approve" });
  assert.equal(!a.ok && a.status, 403);
  const sv = await s.gov.decide(people.service, id, { decision: "approve" });
  assert.match(!sv.ok ? sv.detail : "", /named person/);
  const ok = await s.gov.decide(people.operator, id, { decision: "approve" });
  assert.ok(ok.ok);
  assert.equal(s.gov.current(id)!.status, "verified", s.gov.current(id)!.statusDetail ?? "");
  assert.equal(s.plant.temp, 64.5);
  assert.deepEqual(s.ledger.history(id).map((h) => (h.value as { status: string }).status), ["requested", "approved", "applied", "verified"]);
  const bad = await s.req("sp:temp", 0, "k2");
  assert.equal(!bad.ok && bad.status, 422, "outside the envelope: rejected at request, never clamped");
  const two = await s.gov.request(people.agent, { idempotencyKey: "k3", target: { elementId: "sp:temp" }, proposed: { value: 63, other: 1 }, exceptionType: "setpoint-change" }, "W2");
  assert.equal(!two.ok && two.status, 400, "a setpoint request proposes exactly { value }");
  const none = await s.req("sp:nothing", 1, "k4");
  assert.equal(!none.ok && none.status, 403);
});

test("W2 fuzz: of 10,000 proposed values around the envelope, none outside it becomes a request", async () => {
  const s = setup();
  let accepted = 0, outside = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 10_000; i++) {
    const v = rnd() < 0.05 ? (["64", null, true, NaN, Infinity][i % 5] as unknown) : 50 + rnd() * 25; // 50..75 around 55..70, step 3 from 62
    const r = await s.req("sp:temp", v, `f${i}`);
    const inside = typeof v === "number" && Number.isFinite(v) && v >= 55 && v <= 70 && Math.abs(v - 62) <= 3;
    if (r.ok) { accepted++; assert.ok(inside, `accepted ${v}`); } else if (!inside) outside++;
    else assert.fail(`refused an in-envelope value ${v}: ${r.detail}`);
  }
  console.log(`# fuzz: ${accepted} accepted, ${outside} outside refused, 0 outside accepted`);
  assert.ok(accepted > 500 && outside > 5000);
});

test("W2 failure modes: ack without apply → compensated; device refusal → rejected; stale → rejected; not Good → refused; suspended → held", async () => {
  const s = setup();
  // A device that acknowledges and does not apply: read-back mismatch, compensation, rolled_back.
  const g = s.idOf(await s.req("sp:ghost", 60, "g1"));
  await s.gov.decide(people.operator, g, { decision: "approve" });
  assert.equal(s.gov.current(g)!.status, "rolled_back");
  assert.equal(s.gov.current(g)!.verification!.match, false);
  assert.equal(s.plant.ghost, 50);

  // The device refuses the write: a refusal, so rejected, not retried.
  const l = s.idOf(await s.req("sp:locked", 20, "l1"));
  await s.gov.decide(people.operator, l, { decision: "approve" });
  assert.equal(s.gov.current(l)!.status, "rejected");
  assert.match(s.gov.current(l)!.statusDetail!, /refused/);
  assert.equal(s.plant.locked, 10);

  // The value moves between request and approval: stale.
  const st = s.idOf(await s.req("sp:temp", 63, "st1"));
  s.plant.temp = 61;
  await s.gov.decide(people.operator, st, { decision: "approve" });
  assert.equal(s.gov.current(st)!.status, "rejected");
  assert.match(s.gov.current(st)!.statusDetail!, /stale/);
  assert.equal(s.plant.temp, 61);

  // A tag not reading Good is never written blind.
  s.quality.temp = "Uncertain";
  const nb = await s.req("sp:temp", 62, "nb1");
  assert.equal(!nb.ok && nb.status, 409);
  s.quality.temp = "Good";

  // Suspended (degraded redundancy): new W2 requests refused; an approved one is held, then applied when it clears.
  const held = s.idOf(await s.req("sp:temp", 62.5, "h1"));
  s.suspend("redundancy is degraded (test)");
  const refused = await s.req("sp:temp", 62, "h2");
  assert.equal(!refused.ok && refused.status, 503);
  await s.gov.decide(people.operator, held, { decision: "approve" });
  assert.equal(s.gov.current(held)!.status, "approved", "held, not applied, while suspended");
  assert.equal(s.plant.temp, 61);
  s.suspend(null);
  await s.gov.resume();
  assert.equal(s.gov.current(held)!.status, "verified");
  assert.equal(s.plant.temp, 62.5);
  assert.equal(await s.ledger.verify(), null);
});
