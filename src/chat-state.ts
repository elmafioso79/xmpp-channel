/**
 * XEP-0085 Chat State Notifications (Typing Indicators)
 * XEP-0333 Chat Markers (Read Receipts)
 * 
 * Provides functions to send typing indicators and read receipts
 */

import { xml } from "@xmpp/client";
import type { Logger } from "./types.js";
import { activeClients } from "./state.js";
import { looksLikeMucJid } from "./rooms.js";

/**
 * Send XEP-0085 chat state notification (typing indicator)
 */
export async function sendChatState(
  accountId: string,
  to: string,
  state: "composing" | "paused" | "active" | "inactive" | "gone",
  log?: Logger
): Promise<void> {
  const xmpp = activeClients.get(accountId);
  if (!xmpp) {
    log?.warn?.(`[${accountId}] Cannot send chat state: no active client`);
    return;
  }
  
  const isGroup = looksLikeMucJid(to);
  const msgType = isGroup ? "groupchat" : "chat";
  
  const stanza = xml(
    "message",
    { to, type: msgType },
    xml(state, { xmlns: "http://jabber.org/protocol/chatstates" })
  );
  
  try {
    await xmpp.send(stanza);
    log?.debug?.(`[${accountId}] Sent chat state '${state}' to ${to}`);
  } catch (err) {
    log?.warn?.(`[${accountId}] Failed to send chat state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Send XEP-0333 chat marker (read receipt)
 */
export async function sendChatMarker(
  accountId: string,
  to: string,
  messageId: string,
  marker: "received" | "displayed" | "acknowledged",
  log?: Logger
): Promise<void> {
  const xmpp = activeClients.get(accountId);
  if (!xmpp) {
    log?.warn?.(`[${accountId}] Cannot send chat marker: no active client`);
    return;
  }
  
  const stanza = xml(
    "message",
    { to, type: "chat" },
    xml(marker, { xmlns: "urn:xmpp:chat-markers:0", id: messageId })
  );
  
  try {
    await xmpp.send(stanza);
    log?.debug?.(`[${accountId}] Sent chat marker '${marker}' for message ${messageId} to ${to}`);
  } catch (err) {
    log?.warn?.(`[${accountId}] Failed to send chat marker: ${err instanceof Error ? err.message : String(err)}`);
  }
}
