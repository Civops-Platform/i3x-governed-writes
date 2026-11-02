// Who is writing. One principal per person, agent or service; never a shared
// identity for anything that writes. How a principal authenticates (bearer token,
// OAuth 2, mTLS) is the server's business; the governor only needs this.

export interface Principal {
  id: string;
  kind: "person" | "agent" | "service";
  /** Roles this principal holds for approvals (W1/W2). An agent may hold roles and still never approves. */
  roles?: string[];
}
