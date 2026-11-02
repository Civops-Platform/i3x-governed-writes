// The ledger WriteRequests live in. Every transition of a request is a new version;
// nothing is updated in place, so a request's version list is its audit trail.
//
// Every version carries the hash of the version written before it, anywhere in the
// ledger, so an edited, removed or reordered version breaks the chain and
// `verify()` says where.
//
// The shipped backend is a JSONL file, replayed on start (or memory only, for
// tests). A redundant deployment needs a shared, fenced ledger: one where only the
// current governor can append, checked inside the append itself. Implement
// `LedgerBackend` over your database for that; the governor only needs `current`,
// `history`, `ids` and `write` (the `GovernorLedger` interface).
//
// Reads (`current`, `history`) are served from memory, so they stay synchronous.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export interface RecordVersion {
  elementId: string;
  version: number;
  value: unknown;
  /** When the record says it was true (the writer's timestamp, or receipt time). */
  timestamp: string;
  writtenAt: string;
  principal: string;
  prevHash: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

/** JSON with object keys sorted, so a value hashes the same after a jsonb round trip (jsonb reorders keys). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export const hashOf = (v: Omit<RecordVersion, "hash">) =>
  createHash("sha256").update(canonical([v.elementId, v.version, v.value, v.timestamp, v.writtenAt, v.principal, v.prevHash])).digest("hex");

/**
 * Thrown by a fenced backend when this process may not write (it is not the
 * governor). The governor lets it through instead of treating it as a system failure.
 */
export class NotLeaderError extends Error { override name = "NotLeaderError"; }

/** Walk a chain in write order. Returns the first broken position (1-based), or null. */
export function verifyChain(rows: RecordVersion[]): { line: number; reason: string } | null {
  let prev = GENESIS;
  for (const [i, v] of rows.entries()) {
    if (v.prevHash !== prev) return { line: i + 1, reason: "previous-hash mismatch (a version was removed or reordered)" };
    const { hash, ...rest } = v;
    if (hashOf(rest) !== hash) return { line: i + 1, reason: "hash mismatch (a version was edited)" };
    prev = hash;
  }
  return null;
}

/**
 * Where versions are appended. `draft` builds the version from the chain head the
 * backend holds; a backend that dedupes by `idempotencyKey` returns the version
 * already written for that key instead of appending a second one.
 */
export interface LedgerBackend {
  append(draft: (prevHash: string) => RecordVersion, idempotencyKey?: string): Promise<RecordVersion>;
  verify(): Promise<{ line: number; reason: string } | null>;
}

/** What the governor needs from a ledger. */
export interface GovernorLedger {
  current(elementId: string): RecordVersion | undefined;
  history(elementId: string): RecordVersion[];
  ids(): string[];
  write(elementId: string, value: unknown, principal: string, timestamp?: string, idempotencyKey?: string): Promise<RecordVersion>;
}

export class Ledger implements GovernorLedger {
  private versions = new Map<string, RecordVersion[]>();
  private backend: LedgerBackend;
  private lastHash = GENESIS;

  /** A JSONL file ledger. `null` keeps it in memory only. */
  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const v = JSON.parse(line) as RecordVersion;
        this.index(v);
        this.lastHash = v.hash;
      }
    }
    if (file) mkdirSync(dirname(file), { recursive: true });
    this.backend = {
      append: async (draft) => {
        const v = draft(this.lastHash);
        if (this.file) appendFileSync(this.file, JSON.stringify(v) + "\n");
        this.lastHash = v.hash;
        return v;
      },
      verify: async () => (this.file && existsSync(this.file)
        ? verifyChain(readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)))
        : null),
    };
  }

  /** Called when an element id is seen for the first time (the address space grows). */
  onNewElement: (elementId: string) => void = () => {};

  private index(v: RecordVersion) {
    const isNew = !this.versions.has(v.elementId);
    const list = this.versions.get(v.elementId) ?? [];
    if (list.some((x) => x.version === v.version)) return;
    list.push(v);
    list.sort((a, b) => a.version - b.version);
    this.versions.set(v.elementId, list);
    if (isNew) this.onNewElement(v.elementId);
  }

  current(elementId: string): RecordVersion | undefined { return this.versions.get(elementId)?.at(-1); }
  history(elementId: string): RecordVersion[] { return this.versions.get(elementId) ?? []; }
  ids(): string[] { return [...this.versions.keys()]; }
  count(): number { let n = 0; for (const l of this.versions.values()) n += l.length; return n; }

  async write(elementId: string, value: unknown, principal: string, timestamp?: string, idempotencyKey?: string): Promise<RecordVersion> {
    const writtenAt = new Date().toISOString();
    const v = await this.backend.append((prevHash) => {
      const base = {
        elementId, value, principal, writtenAt, prevHash,
        version: (this.current(elementId)?.version ?? 0) + 1,
        timestamp: timestamp ?? writtenAt,
      };
      return { ...base, hash: hashOf(base) };
    }, idempotencyKey);
    this.index(v);
    return v;
  }

  verify() { return this.backend.verify(); }
}
