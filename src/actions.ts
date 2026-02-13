/**
 * XMPP actions handler (reactions, polls, etc.)
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ChannelMessageActionName } from "./types.js";
import { getActiveClient } from "./monitor.js";
import { resolveXmppAccount } from "./accounts.js";
import { bareJid } from "./config-schema.js";
import { xml } from "@xmpp/client";
import {
  isOmemoEnabled,
  encryptOmemoMessage,
  encryptMucOmemoMessage,
  NS_OMEMO,
} from "./omemo/index.js";

/**
 * Action gate - check if action is enabled in config
 */
function createActionGate(
  actions?: Record<string, boolean>
): (action: string) => boolean {
  return (action: string) => {
    if (!actions) return false;
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

  try {
    // XEP-0444: Message Reactions
    // Determine message type: groupchat for MUC rooms, chat for DMs
    const isMuc = config.groups?.some((room) => bareJid(room) === bareJid(targetJid));
    const msgType = isMuc ? "groupchat" : "chat";

    const reactionsEl = remove
      ? xml("reactions", { id: messageId, xmlns: "urn:xmpp:reactions:0" })
      : xml(
          "reactions",
          { id: messageId, xmlns: "urn:xmpp:reactions:0" },
          xml("reaction", {}, emoji || "👍")
        );

    const reactionMsgId = `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // When OMEMO is active, wrap the reaction in an OMEMO-encrypted stanza.
    // Clients with OMEMO enforcement (Conversations, Gajim) silently drop
    // plaintext stanzas from contacts with established OMEMO sessions.
    if (isOmemoEnabled(account.accountId)) {
      // Encrypt a minimal payload (empty string) — the reaction data lives
      // in the <reactions> sibling element, not inside the encrypted payload.
      const encryptedElement = isMuc
        ? await encryptMucOmemoMessage(account.accountId, bareJid(targetJid), "", undefined)
        : await encryptOmemoMessage(account.accountId, bareJid(targetJid), "", undefined);

      if (encryptedElement) {
        const message = xml(
          "message",
          { to: targetJid, type: msgType, id: reactionMsgId },
          encryptedElement,
          reactionsEl,
          xml("encryption", {
            xmlns: "urn:xmpp:eme:0",
            namespace: NS_OMEMO,
            name: "OMEMO",
          }),
          xml("store", { xmlns: "urn:xmpp:hints" })
        );

        console.log(`[XMPP:actions] Sending OMEMO-encrypted reaction: to=${targetJid} type=${msgType} refId=${messageId} emoji=${emoji || "👍"}`);
        await client.send(message);
      } else {
        // Encryption failed — fall back to plaintext reaction
        console.log(`[XMPP:actions] OMEMO encryption failed for reaction, sending plaintext: to=${targetJid}`);
        const message = xml(
          "message",
          { to: targetJid, type: msgType, id: reactionMsgId },
          reactionsEl,
          xml("store", { xmlns: "urn:xmpp:hints" })
        );
        await client.send(message);
      }
    } else {
      // No OMEMO — send plaintext reaction
      const message = xml(
        "message",
        { to: targetJid, type: msgType, id: reactionMsgId },
        reactionsEl,
        xml("store", { xmlns: "urn:xmpp:hints" })
      );

      console.log(`[XMPP:actions] Sending plaintext reaction: to=${targetJid} type=${msgType} refId=${messageId} emoji=${emoji || "👍"}`);
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

    const messageId = actionParams.messageId as string;
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
