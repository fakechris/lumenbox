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
export { FileUserIdStore, MemoryUserIdStore } from "./session.ts";
export { PoppyRefused, poppyRequest, usePoppyTransport, withinSite, type PoppyTransport } from "./http.ts";
export type { AgentIdentity } from "./identity.ts";

// Phase 2: OAuth
export { discoverAuthServer, clearAuthServerCache, OAuthError } from "./oauth.ts";
export type { AuthServerMeta, TokenSet, DeviceCodeResponse } from "./oauth.ts";

// Phase 2: Token Store
export { TokenStore } from "./token-store.ts";

// Phase 2: UCP
export { UcpClient, UcpError } from "./ucp.ts";
export type { UcpProfile, UcpCapabilities, UcpCart, UcpCheckout, UcpOrder, UcpCartItem } from "./ucp.ts";

// Phase 3: Browser Join
export { requestBrowserJoin } from "./browser-join.ts";
export type { BrowserJoinResult } from "./browser-join.ts";

// Phase 3: Conversations
export { conversationEndpoint, sendMessage } from "./conversations.ts";
export type { ConversationEndpoint, ConversationMessage, ConversationEvent, ConversationEventHandler } from "./conversations.ts";

// Phase 3: Operations
export { respondToOperation, policyLevel, consentDescription, parseOperation } from "./operations.ts";
export type { Operation, OperationDecision, OperationResult } from "./operations.ts";
