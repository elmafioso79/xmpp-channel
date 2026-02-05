/**
 * Inbound Message Handling
 * 
 * Handles routing inbound XMPP messages to OpenClaw
 */

import { xml } from "@xmpp/client";
import { bareJid } from "./config-schema.js";
import { getXmppRuntime } from "./runtime.js";
import { normalizeAllowFrom, isSenderAllowed } from "./normalize.js";
import { sendXmppMedia } from "./outbound.js";
import type { XmppConfig, XmppInboundMessage, Logger, ChannelAccountStatusPatch } from "./types.js";
import { activeClients } from "./state.js";
import { sendChatState } from "./chat-state.js";

/**
 * Handle inbound message - validate allowlist and route to OpenClaw
 */
export async function handleInboundMessage(
  message: XmppInboundMessage,
  cfg: unknown,
  accountId: string,
  config: XmppConfig,
  log?: Logger,
  setStatus?: (patch: ChannelAccountStatusPatch) => void
): Promise<void> {
  const rt = getXmppRuntime();

  // Update last inbound timestamp
  setStatus?.({
    accountId,
    lastInboundAt: Date.now(),
  });

  // Check allowlist - different logic for groups vs DMs
  const senderBare = bareJid(message.from);
  
  if (message.isGroup) {
    // For groups: check groupPolicy first
    const groupPolicy = config.groupPolicy ?? "open";
    
    if (groupPolicy === "disabled") {
      // Disabled policy - block all group messages
      log?.debug?.(`[XMPP] Group message blocked (groupPolicy: disabled)`);
      return;
    } else if (groupPolicy === "open") {
      // Open policy - allow all group messages
      log?.debug?.(`[XMPP] Group message allowed (groupPolicy: open)`);
    } else {
      // Allowlist policy - check groupAllowFrom (falls back to allowFrom)
      const groupAllowList = normalizeAllowFrom(config.groupAllowFrom ?? config.allowFrom);
      if (!isSenderAllowed(groupAllowList, senderBare)) {
        log?.debug?.(`[XMPP] Group message blocked: ${senderBare} not in groupAllowFrom`);
        return;
      }
    }
  } else {
    // For DMs: check dmPolicy and allowFrom
    const dmPolicy = config.dmPolicy ?? "open";
    
    if (dmPolicy === "disabled") {
      // Disabled policy - block all DMs
      log?.debug?.(`[XMPP] DM blocked (dmPolicy: disabled)`);
      return;
    } else if (dmPolicy === "open") {
      log?.debug?.(`[XMPP] DM allowed (dmPolicy: open)`);
    } else {
      // pairing or allowlist - check allowFrom
      const allowFrom = normalizeAllowFrom(config.allowFrom);
      if (!isSenderAllowed(allowFrom, senderBare)) {
        log?.debug?.(`[XMPP] DM blocked: ${senderBare} not in allowFrom (dmPolicy: ${dmPolicy})`);
        return;
      }
    }
  }

  log?.info?.(`[XMPP] Inbound: from=${senderBare} isGroup=${message.isGroup} body="${message.body.slice(0, 50)}..."`);

  // Simple command authorization - if sender is allowed, they can use commands
  // Commands are handled by OpenClaw core when CommandAuthorized is true
  const dmPolicy = config.dmPolicy ?? "open";
  const allowFromList = normalizeAllowFrom(config.allowFrom);
  const senderAllowedForDm = dmPolicy === "open" || isSenderAllowed(allowFromList, senderBare);
  
  // Authorize commands for any allowed sender
  const commandAuthorized = senderAllowedForDm;
  
  // Route to OpenClaw
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: "xmpp",
    accountId,
    peer: {
      kind: message.isGroup ? "group" : "dm",
      id: message.isGroup ? message.roomJid! : senderBare,
    },
  });

  const storePath = rt.channel.session.resolveStorePath((cfg as { session?: { store?: string } }).session?.store, {
    agentId: route.agentId,
  });

  // Build the message context using finalizeInboundContext (same pattern as other channels)
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: message.body,
    RawBody: message.body,
    CommandBody: message.body,
    From: `xmpp:${senderBare}`,
    To: `xmpp:${message.to}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: message.isGroup ? message.roomJid : senderBare,
    SenderName: message.senderNick || senderBare.split("@")[0],
    SenderId: senderBare,
    Provider: "xmpp",
    Surface: "xmpp",
    MessageSid: message.id || `xmpp-${Date.now()}`,
    OriginatingChannel: "xmpp" as const,
    OriginatingTo: `xmpp:${message.isGroup ? message.roomJid : senderBare}`,
    CommandAuthorized: commandAuthorized,
  });

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey ?? route.sessionKey,
    ctx,
    // Only update lastRoute for DMs, not groups (to avoid main session showing as group)
    updateLastRoute: message.isGroup ? undefined : {
      sessionKey: route.mainSessionKey,
      channel: "xmpp",
      to: senderBare,
      accountId,
    },
    onRecordError: (err: unknown) => {
      log?.error?.(`[XMPP] Failed to record inbound session: ${String(err)}`);
    },
  });

  // Dispatch reply
  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async (payload: { text?: string; markdown?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
        await deliverReply(payload, message, config, accountId, senderBare, log, setStatus);
      },
    },
  });
}

/**
 * Deliver a reply to the sender
 */
async function deliverReply(
  payload: { text?: string; markdown?: string; mediaUrl?: string; mediaUrls?: string[] },
  message: XmppInboundMessage,
  config: XmppConfig,
  accountId: string,
  senderBare: string,
  log?: Logger,
  setStatus?: (patch: ChannelAccountStatusPatch) => void
): Promise<void> {
  log?.debug?.(`[XMPP] Deliver: text=${!!payload.text} markdown=${!!payload.markdown} media=${!!(payload.mediaUrl || payload.mediaUrls?.length)}`);
  
  const xmppClient = activeClients.get(accountId);
  if (!xmppClient) {
    log?.error?.("[XMPP] No active client for reply");
    return;
  }

  const replyTo = message.isGroup ? message.roomJid! : senderBare;
  const msgType = message.isGroup ? "groupchat" : "chat";
  const textToSend = payload.markdown || payload.text;
  
  // Send typing indicator (XEP-0085) before response
  await sendChatState(accountId, replyTo, "composing", log);
  
  // Collect all media URLs
  const allMediaUrls: string[] = [];
  if (payload.mediaUrl) {
    allMediaUrls.push(payload.mediaUrl);
  }
  if (payload.mediaUrls && payload.mediaUrls.length > 0) {
    allMediaUrls.push(...payload.mediaUrls);
  }
  
  // If we have media URLs, use HTTP Upload
  if (allMediaUrls.length > 0) {
    log?.debug?.(`[XMPP] Sending ${allMediaUrls.length} media item(s) to ${replyTo}`);
    
    for (let i = 0; i < allMediaUrls.length; i++) {
      const mediaUrl = allMediaUrls[i];
      // Only include caption on first media
      const caption = i === 0 ? textToSend : undefined;
      
      log?.debug?.(`[XMPP] Media ${i + 1}/${allMediaUrls.length}: ${mediaUrl.slice(0, 80)}`);
      
      const result = await sendXmppMedia(config, replyTo, mediaUrl, caption, {
        log,
        accountId,
      });
      
      if (!result.ok) {
        log?.error?.(`[XMPP] Failed to send media: ${result.error}`);
      } else {
        log?.debug?.(`[XMPP] Media sent to ${replyTo}`);
        // Update lastOutboundAt
        setStatus?.({ accountId, lastOutboundAt: Date.now() });
      }
    }
    // Clear typing indicator
    await sendChatState(accountId, replyTo, "active", log);
    return;
  }
  
  // No media, send text only
  if (!textToSend) {
    log?.debug?.("[XMPP] No text or media to send, skipping");
    await sendChatState(accountId, replyTo, "active", log);
    return;
  }
  
  log?.info?.(`[XMPP] Reply to ${replyTo}: ${textToSend.slice(0, 50)}...`);

  // Build reply with XEP-0461 reply context (reference original message)
  const replyChildren: ReturnType<typeof xml>[] = [
    xml("body", {}, textToSend),
  ];
  
  // Include XEP-0461 reply reference to original message
  if (message.id) {
    replyChildren.push(
      xml("reply", { 
        xmlns: "urn:xmpp:reply:0", 
        to: message.from,
        id: message.id,
      })
    );
    // Add fallback for clients that don't support XEP-0461
    replyChildren.push(
      xml("fallback", { xmlns: "urn:xmpp:fallback:0", for: "urn:xmpp:reply:0" })
    );
  }
  
  const reply = xml(
    "message",
    { to: replyTo, type: msgType, id: `reply-${Date.now()}` },
    ...replyChildren
  );

  await xmppClient.send(reply);
  log?.debug?.(`[XMPP] Sent to ${replyTo}`);
  
  // Update lastOutboundAt and clear typing indicator
  setStatus?.({ accountId, lastOutboundAt: Date.now() });
  await sendChatState(accountId, replyTo, "active", log);
}
