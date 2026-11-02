// Verify a ledger file: the hash chain, and where every WriteRequest ended up.
//
//   npx tsx scripts/verify-ledger.ts <ledger.jsonl>
//
// Exits 1 if the chain is broken.

import { readFileSync } from "node:fs";
import { verifyChain, WR_PREFIX, type RecordVersion, type WriteRequestValue } from "../src/index";

const file = process.argv[2];
if (!file) { console.error("usage: verify-ledger.ts <ledger.jsonl>"); process.exit(2); }
const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RecordVersion);
const broken = verifyChain(rows);
const last = new Map<string, WriteRequestValue>();
for (const r of rows) if (r.elementId.startsWith(WR_PREFIX)) last.set(r.elementId, r.value as WriteRequestValue);
const byStatus: Record<string, number> = {};
for (const v of last.values()) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
console.log(`ledger rows ${rows.length}; chain ${broken ? `BROKEN at line ${broken.line}: ${broken.reason}` : "intact"}`);
console.log(`write requests ${last.size}: ${Object.entries(byStatus).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
const unapproved = [...last.entries()].filter(([, v]) => ["applied", "verified", "rolled_back"].includes(v.status) && !v.approvals.some((a) => a.decision === "approve"));
if (unapproved.length) console.log(`APPLIED WITHOUT AN APPROVAL: ${unapproved.map(([id]) => id).join(", ")}`);
process.exit(broken || unapproved.length ? 1 : 0);
