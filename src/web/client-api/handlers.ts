/**
 * What each `/api/v1` operation answers: a resource of `schema.ts`, built field by field from
 * what the server knows. Never an internal object passed through — a field the schema does not
 * name never reaches a client, and the contract tests check that on every answer.
 */

import { getAgent, listAgents } from "./agents.ts";
import { deleteDevice, exchangeOAuthCode, listAuthProviders, listDevices, pairDevice, refreshDeviceToken, signOutDevice, startOAuth } from "./auth.ts";
import { sendCardAction, sendMessage, stopTurn, streamConversation, uploadFile } from "./chat.ts";
import { listConversations, listMessages } from "./conversations.ts";
import type { Handlers } from "./frame.ts";
import { answerInboxItem, decideApproval, decideWork, getNotification, listInbox } from "./inbox.ts";
import { meOf } from "./me.ts";
import { getBoard, getWork, listWork, listWorkHistory } from "./work.ts";
import { getChanges, streamEvents } from "./sync.ts";
import { API_VERSION, OPERATIONS } from "./schema.ts";

export const HANDLERS: Handlers = {
  listAgents, getAgent, listWork, getWork, listWorkHistory, getBoard, getChanges, streamEvents,
  listAuthProviders, startOAuth, exchangeOAuthCode, pairDevice, refreshDeviceToken, signOutDevice, listDevices, deleteDevice,
  listInbox, decideApproval, answerInboxItem, decideWork, getNotification,
  listConversations, listMessages, sendMessage, sendCardAction, stopTurn, streamConversation, uploadFile,

  getMeta: ({ deps }) => ({
    api: API_VERSION,
    server: deps.version,
    installation: { mode: deps.installationMode() },
    capabilities: OPERATIONS.filter(operation => operation.tier === "stable").map(operation => operation.operationId),
    preview: OPERATIONS.filter(operation => (operation.tier as string) === "preview").map(operation => operation.operationId),
  }),

  getMe: meOf,
};
