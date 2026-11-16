/**
 * Personal Agent Protocol (Poppy) support for agentbox.
 *
 * Re-exports everything callers need; nothing outside this directory
 * imports from its internals.
 */

export { PoppyManager, type PoppyManagerOptions } from "./manager.ts";
export { discoverCompany, hasUcpExtension, ucpEndpoint, clearDiscoveryCache } from "./discovery.ts";
export type { PoppyCompany } from "./discovery.ts";
export type { PoppySession } from "./session.ts";
export type { UserIdStore } from "./session.ts";
export { MemoryUserIdStore } from "./session.ts";
export type { AgentIdentity } from "./identity.ts";
