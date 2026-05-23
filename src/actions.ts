/**
 * XMPP actions handler (reactions, polls, etc.)
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { ChannelMessageActionName } from "./types.js";
import { getActiveClient } from "./monitor.js";
import { resolveXmppAccount } from "./accounts.js";
import { bareJid } from "./config-schema.js";
import { xml } from "@xmpp/client";
import { getServerMessageId, getRecentInboundMessageId, isKnownMucRoom } from "./state.js";
import {
  isOmemoEnabled,
  encryptOmemoMessage,
  encryptMucOmemoMessage,
  NS_OMEMO,
} from "./omemo/index.js";

/**
 * Resolve the target JID for a message.
 * For MUC (groupchat), messages are sent to the bare room JID without a resource.
 * The /nickname resource is only used when JOINING a room, not when sending messages.
 */
function resolveMucTarget(targetJid: string, isMuc: boolean, _config: { nickname?: string }): string {
  if (!isMuc) {
    return targetJid;
  }
  // For MUC, always use bare room JID (no resource/nickname)
  // Messages to MUC rooms go to room@service, not room@service/nick
  return bareJid(targetJid);
}

/**
 * Action gate - check if action is enabled in config
 */
function createActionGate(
  actions?: Record<string, boolean>
): (action: string) => boolean {
  return (action: string) => {
    if (!actions) {return false;}
    return actions[action] === true;
  };
}

/**
 * List available actions for XMPP
 */
export function listXmppActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  const actionsConfig = xmppConfig?.actions as Record<string, boolean> | undefined;

  if (!actionsConfig) {
    return [];
  }

  const gate = createActionGate(actionsConfig);
  const actions: ChannelMessageActionName[] = [];

  // XEP-0444: Message Reactions
  if (gate("reactions")) {
    actions.push("react");
  }

  return actions;
}

/**
 * Check if action is supported
 */
export function supportsXmppAction(action: string): boolean {
  return action === "react";
}

/**
 * Handle XMPP action (reaction)
 */
export async function handleXmppAction(params: {
  action: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatJid: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
}) {
  const { action, cfg, accountId, chatJid, messageId, emoji, remove } = params;

  // Safety: strip xmpp: prefix if it leaked through
  const targetJid = chatJid.replace(/^xmpp:/, "");

  // Log action attempt for debugging
  console.log(`[XMPP:actions] handleXmppAction: action=${action} chatJid=${targetJid} messageId=${messageId} emoji=${emoji} accountId=${accountId} remove=${remove}`);

  if (action !== "react") {
    return jsonResult({ ok: false, error: `Unsupported XMPP action: ${action}` });
  }

  const account = resolveXmppAccount({ cfg, accountId });
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  const actionsConfig = xmppConfig?.actions as Record<string, boolean> | undefined;

  const gate = createActionGate(actionsConfig);
  if (!gate("reactions")) {
    return jsonResult({ ok: false, error: "XMPP reactions are disabled — set actions.reactions: true in config" });
  }

  const config = account.config;
  const client = getActiveClient(account.accountId);
  if (!client) {
    return jsonResult({ ok: false, error: "XMPP client not connected" });
  }

  // Check if targetJid is a known MUC room (configured or dynamically joined)
  const isMuc = isKnownMucRoom(account.accountId, targetJid, config.groups);

  // Determine message type: groupchat for MUC rooms, chat for DMs
  const msgType = isMuc ? "groupchat" : "chat";

  try {
    // The messageId from the AI/LLM is based on the INBOUND message's stanza-id.
    // We need to look up the server-assigned ID, or use fallback if AI passes wrong ID.
    const serverMessageId = getServerMessageId(account.accountId, messageId, targetJid);

    // Build reactions element - use simple xml() call which works correctly
    // (The c()/t() approach causes circular JSON errors, but the simple approach works)
    const reactionsEl = remove
      ? xml("reactions", { id: serverMessageId, xmlns: "urn:xmpp:reactions:0" })
      : xml("reactions", { id: serverMessageId, xmlns: "urn:xmpp:reactions:0" },
          xml("reaction", {}, emoji || "👍"));

    const reactionMsgId = `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // XEP-0444 + XEP-0420: Send reactions BOTH encrypted AND as plaintext sibling
    // 
    // Native XMPP clients (Conversations, Gajim) send reactions as:
    // 1. Plaintext <reactions> sibling - for display by the receiving client
    // 2. OMEMO-encrypted payload (can be empty) - to keep session active
    //
    // The plaintext sibling is what clients display as emoji reactions.
    // Without it, clients show the decrypted XML payload as plain text!
    //
    // Message structure (correct format):
    // <message>
    //   <encrypted xmlns="eu.siacs.conversations.axolotl">
    //     <header sid="...">
    //       <key rid="...">...</key>
    //       <iv>...</iv>
    //     </header>
    //     <payload>BASE64</payload>  <- Can be empty or contain SCE wrapper
    //   </encrypted>
    //   <reactions id="..." xmlns="urn:xmpp:reactions:0">  <- Plaintext sibling for display!
    //     <reaction>👍</reaction>
    //   </reactions>
    //   <encryption xmlns="urn:xmpp:eme:0" namespace="eu.siacs.conversations.axolotl" name="OMEMO"/>
    //   <store xmlns="urn:xmpp:hints"/>
    // </message>
    if (isOmemoEnabled(account.accountId)) {
      // Build the OMEMO encrypted payload (keep session active, can be empty)
      const payloadContent = ""; // Empty - the plaintext sibling handles the reaction display

      const encryptedElement = isMuc
        ? await encryptMucOmemoMessage(account.accountId, bareJid(targetJid), payloadContent, undefined)
        : await encryptOmemoMessage(account.accountId, bareJid(targetJid), payloadContent, undefined);

      if (encryptedElement) {
        // Send BOTH encrypted payload (keeps session active) AND plaintext reactions (for display)
        const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
        const message = xml(
          "message",
          { to: resolvedTarget, type: msgType, id: reactionMsgId },
          encryptedElement,
          reactionsEl,  // Plaintext sibling - THIS is what clients display as emoji!
          xml("encryption", {
            xmlns: "urn:xmpp:eme:0",
            namespace: NS_OMEMO,
            name: "OMEMO",
          }),
          xml("store", { xmlns: "urn:xmpp:hints" })
        );

        console.log(`[XMPP:actions] Sending OMEMO + plaintext reaction sibling: to=${resolvedTarget} type=${msgType} refId=${serverMessageId} emoji=${emoji || "👍"}`);
        await client.send(message);
      } else {
        // Encryption failed — fall back to plaintext reaction only
        console.log(`[XMPP:actions] OMEMO encryption failed for reaction, sending plaintext: to=${targetJid}`);
        const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
        const message = xml(
          "message",
          { to: resolvedTarget, type: msgType, id: reactionMsgId },
          reactionsEl,
          xml("store", { xmlns: "urn:xmpp:hints" })
        );
        await client.send(message);
      }
    } else {
      // No OMEMO — send plaintext reaction
      // Note: Don't include empty body - it can cause issues with some clients (like Gajim)
      // The <reactions> element is sufficient per XEP-0444
      const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
      const message = xml(
        "message",
        { to: resolvedTarget, type: msgType, id: reactionMsgId },
        reactionsEl,
        xml("store", { xmlns: "urn:xmpp:hints" })
      );

      console.log(`[XMPP:actions] Sending plaintext reaction: to=${resolvedTarget} type=${msgType} refId=${serverMessageId} emoji=${emoji || "👍"}`);
      await client.send(message);
    }

    if (remove) {
      return jsonResult({ ok: true, removed: true });
    }
    return jsonResult({ ok: true, added: emoji || "👍" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return jsonResult({ ok: false, error: `XMPP reaction failed: ${error}` });
  }
}

/**
 * XMPP Message Actions adapter
 */
export const xmppMessageActions = {
  describeMessageTool: ({ cfg }: { cfg: OpenClawConfig }) => ({
    actions: listXmppActions(cfg),
    capabilities: [],
    schema: [],
    mediaSourceParams: [],
  }),
  listActions: ({ cfg }: { cfg: OpenClawConfig }) => listXmppActions(cfg),

  supportsAction: ({ action }: { action: string }) => supportsXmppAction(action),

  handleAction: async (params: {
    action: string;
    params: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
    toolContext?: { currentChannelId?: string; currentThreadId?: string };
  }) => {
    const { action, params: actionParams, cfg, accountId, toolContext } = params;

    let messageId = actionParams.messageId as string | undefined;
    const emoji = actionParams.emoji as string | undefined;
    const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : undefined;

    // Resolve target: chatJid > to > toolContext.currentChannelId (same pattern as WhatsApp)
    let chatJid = (actionParams.chatJid as string) || (actionParams.to as string);
    if (!chatJid && toolContext?.currentChannelId) {
      chatJid = toolContext.currentChannelId;
    }
    // Always strip channel prefix — LLM may pass "xmpp:user@server"
    if (chatJid) {
      chatJid = chatJid.replace(/^xmpp:/, "");
    }

    if (!chatJid) {
      return jsonResult({ ok: false, error: "Target JID is required (pass chatJid, to, or use within a session context)" });
    }

    // If messageId is not provided, try to use the most recent inbound message ID from this conversation
    if (!messageId) {
      // Get the account ID to look up the recent message
      const account = resolveXmppAccount({ cfg, accountId });
      const recentId = getRecentInboundMessageId(account.accountId, bareJid(chatJid));
      if (recentId) {
        messageId = recentId;
        console.log(`[XMPP:actions] No messageId provided, using recent inbound message ID: ${messageId}`);
      }
    }

    if (!messageId) {
      return jsonResult({ ok: false, error: "messageId is required for reactions" });
    }

    try {
      return await handleXmppAction({
        action,
        cfg,
        accountId,
        chatJid: bareJid(chatJid),
        messageId,
        emoji,
        remove,
      });
    } catch (err) {
      // Always return jsonResult so content[] is never undefined in session history
      return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  extractToolSend: () => null,
};
