/**
 * XMPP actions handler (reactions, polls, etc.)
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelMessageActionName } from "./types.js";
import { getActiveClient } from "./monitor.js";
import { resolveXmppAccount } from "./accounts.js";
import { bareJid } from "./config-schema.js";
import { xml } from "@xmpp/client";

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
}): Promise<{ ok: boolean; error?: string }> {
  const { action, cfg, accountId, chatJid, messageId, emoji, remove } = params;

  if (action !== "react") {
    return { ok: false, error: `Unsupported action: ${action}` };
  }

  const account = resolveXmppAccount({ cfg, accountId });
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  const actionsConfig = xmppConfig?.actions as Record<string, boolean> | undefined;

  const gate = createActionGate(actionsConfig);
  if (!gate("reactions")) {
    return { ok: false, error: "XMPP reactions are disabled" };
  }

  const config = account.config;
  const client = getActiveClient(account.accountId);
  if (!client) {
    return { ok: false, error: "XMPP client not connected" };
  }

  try {
    // XEP-0444: Message Reactions
    // <message to="chat@example.com" type="chat" id="reaction-1">
    //   <reactions id="original-message-id" xmlns="urn:xmpp:reactions:0">
    //     <reaction>👍</reaction>
    //   </reactions>
    //   <store xmlns="urn:xmpp:hints"/>
    // </message>

    // Determine message type: groupchat for MUC rooms, chat for DMs
    const isMuc = config.groups?.some((room) => bareJid(room) === bareJid(chatJid));
    const msgType = isMuc ? "groupchat" : "chat";

    const reactions = remove
      ? xml("reactions", { id: messageId, xmlns: "urn:xmpp:reactions:0" })
      : xml(
          "reactions",
          { id: messageId, xmlns: "urn:xmpp:reactions:0" },
          xml("reaction", {}, emoji || "👍")
        );

    const message = xml(
      "message",
      { to: chatJid, type: msgType, id: `reaction_${Date.now()}` },
      reactions,
      xml("store", { xmlns: "urn:xmpp:hints" })
    );

    await client.send(message);

    return {
      ok: true,
      ...(remove ? { removed: true } : { added: emoji || "👍" }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
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
      chatJid = toolContext.currentChannelId.replace(/^xmpp:/, "");
    }

    if (!chatJid) {
      return { ok: false, error: "Target JID is required (pass chatJid, to, or use within a session context)" };
    }

    if (!messageId) {
      return { ok: false, error: "messageId is required" };
    }

    return handleXmppAction({
      action,
      cfg,
      accountId,
      chatJid: bareJid(chatJid),
      messageId,
      emoji,
      remove,
    });
  },

  extractToolSend: () => null,
};
