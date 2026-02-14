/**
 * Inbound Message Handling
 * 
 * Handles routing inbound XMPP messages to OpenClaw
 */

import { xml } from "@xmpp/client";
import { randomUUID } from "crypto";
import { bareJid } from "./config-schema.js";
import { getXmppRuntime } from "./runtime.js";
import { normalizeAllowFrom, isSenderAllowed } from "./normalize.js";
import { sendXmppMedia } from "./outbound.js";
import type { XmppConfig, XmppInboundMessage, Logger, ChannelAccountStatusPatch } from "./types.js";
import { activeClients, recordInboundMessageId } from "./state.js";
import { sendChatState, sendChatMarker } from "./chat-state.js";
import { isOmemoEnabled, encryptOmemoMessage, encryptMucOmemoMessage, isRoomOmemoCapable, buildOmemoMessageStanza } from "./omemo/index.js";

/**
 * Generate a proper XMPP message ID
 */
function generateMessageId(): string {
  return randomUUID();
}

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

  // Check allowlist - different logic for groups vs direct chats
  const senderBare = bareJid(message.from);
  
  // First check if sender is in allowFrom (owners) - they always have access
  const allowFromList = normalizeAllowFrom(config.allowFrom);
  const isOwner = isSenderAllowed(allowFromList, senderBare);
  
  if (message.isGroup) {
    // For groups: check groupPolicy first
    const groupPolicy = config.groupPolicy ?? "open";
    
    if (groupPolicy === "open") {
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
    // For direct chats: owners (allowFrom) always have access
    if (isOwner) {
      log?.debug?.(`[XMPP] Direct chat allowed (owner ${senderBare} is in allowFrom)`);
    } else {
      // Non-owners (guests): check dmPolicy
      const dmPolicy = config.dmPolicy ?? "open";
      
      if (dmPolicy === "disabled") {
        log?.debug?.(`[XMPP] Direct chat blocked (dmPolicy: disabled, guest ${senderBare})`);
        return;
      } else if (dmPolicy === "open") {
        log?.debug?.(`[XMPP] Direct chat allowed (dmPolicy: open)`);
      } else if (dmPolicy === "allowlist") {
        // allowlist mode: check dmAllowlist (owners already passed above)
        const dmAllowList = normalizeAllowFrom(config.dmAllowlist);
        if (isSenderAllowed(dmAllowList, senderBare)) {
          log?.debug?.(`[XMPP] Direct chat allowed (dmPolicy: allowlist, ${senderBare} in dmAllowlist)`);
        } else {
          log?.debug?.(`[XMPP] Direct chat blocked: guest ${senderBare} not in dmAllowlist`);
          return;
        }
      } else {
        // pairing or unknown policy - let OpenClaw core handle pairing flow
        log?.debug?.(`[XMPP] Direct chat: guest ${senderBare}, dmPolicy=${dmPolicy}`);
      }
    }
  }

  // For groups, sender identity is the full occupant JID (room@conference/nickname)
  // For direct chats, sender identity is the bare JID (user@server)
  const senderIdentity = message.isGroup ? message.from : senderBare;
  
  log?.info?.(`[XMPP] Inbound: from=${senderIdentity} isGroup=${message.isGroup} body="${message.body.slice(0, 50)}..."`);

  // XEP-0333: Send read receipt (displayed marker) if enabled
  const sendReadReceipts = config.sendReadReceipts !== false; // default true
  if (sendReadReceipts && message.id && !message.isGroup) {
    try {
      await sendChatMarker(accountId, senderBare, message.id, "displayed", log);
    } catch (err) {
      log?.warn?.(`[XMPP] Failed to send read receipt: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!sendReadReceipts) {
    log?.debug?.(`[XMPP] Read receipts disabled, skipping for message ${message.id}`);
  }

  // Command authorization: owners (allowFrom) always authorized,
  // guests authorized only when dmPolicy allows them through
  const commandAuthorized = isOwner || (config.dmPolicy ?? "open") === "open";
  
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
    From: `xmpp:${senderIdentity}`,
    To: `xmpp:${message.to}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: message.isGroup ? message.roomJid : senderBare,
    SenderName: message.senderNick || senderBare.split("@")[0],
    SenderId: senderIdentity,
    Provider: "xmpp",
    Surface: "xmpp",
    MessageSid: message.stanzaId || message.id || `xmpp-${Date.now()}`,
    OriginatingChannel: "xmpp" as const,
    OriginatingTo: `xmpp:${message.isGroup ? message.roomJid : senderBare}`,
    CommandAuthorized: commandAuthorized,
  });

  // Record the inbound message ID for potential reaction fallback
  // This helps when AI passes wrong messageId - we can use the most recent message as fallback
  // Prefer rawStanzaId (stanza's 'id' attr used by Gajim) > stanzaId (XEP-0359) > id
  const inboundMessageId = message.rawStanzaId || message.stanzaId || message.id;
  if (inboundMessageId) {
    // For DMs, record with senderBare
    if (!message.isGroup && senderBare) {
      recordInboundMessageId(accountId, senderBare, inboundMessageId);
      console.log(`[XMPP:inbound] Recorded inbound message ID: ${inboundMessageId} (rawStanzaId=${message.rawStanzaId}, stanzaId=${message.stanzaId}, id=${message.id}) from ${senderBare}`);
    }
    // For MUC/group, also record with roomJid so fallback lookup can find it
    // (AI will use roomJid as target when reacting to group messages)
    if (message.isGroup && message.roomJid) {
      recordInboundMessageId(accountId, message.roomJid, inboundMessageId);
      console.log(`[XMPP:inbound] Recorded inbound message ID for group: ${inboundMessageId} from room ${message.roomJid}`);
    }
  }

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

  log?.info?.(`[XMPP] Dispatching reply for session ${route.sessionKey}`);
  
  // Dispatch reply
  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async (payload: { text?: string; markdown?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
        log?.info?.(`[XMPP] Deliver callback invoked with: text=${payload.text?.length ?? 0} chars, markdown=${payload.markdown?.length ?? 0} chars`);
        await deliverReply(payload, message, config, accountId, senderIdentity, log, setStatus);
      },
    },
  });
  
  log?.info?.(`[XMPP] Reply dispatch completed`);
}

/**
 * Deliver a reply to the sender
 */
async function deliverReply(
  payload: { text?: string; markdown?: string; mediaUrl?: string; mediaUrls?: string[] },
  message: XmppInboundMessage,
  config: XmppConfig,
  accountId: string,
  senderIdentity: string,
  log?: Logger,
  setStatus?: (patch: ChannelAccountStatusPatch) => void
): Promise<void> {
  log?.info?.(`[XMPP] deliverReply called: text=${!!payload.text} markdown=${!!payload.markdown} media=${!!(payload.mediaUrl || payload.mediaUrls?.length)}`);
  log?.info?.(`[XMPP] deliverReply details: accountId=${accountId} sender=${senderIdentity} isGroup=${message.isGroup} roomJid=${message.roomJid}`);
  
  const xmppClient = activeClients.get(accountId);
  if (!xmppClient) {
    log?.error?.(`[XMPP] No active client for reply (accountId: ${accountId}, available: ${Array.from(activeClients.keys()).join(", ")})`);
    return;
  }

  // For groups: reply to the room
  // For DMs: reply to the sender's bare JID
  const replyTo = message.isGroup ? message.roomJid! : bareJid(senderIdentity);
  const msgType = message.isGroup ? "groupchat" : "chat";
  const textToSend = payload.markdown || payload.text;
  
  log?.info?.(`[XMPP] Will reply to: ${replyTo} (type: ${msgType})`);
  log?.info?.(`[XMPP] Reply text: ${textToSend?.slice(0, 100)}...`);
  
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
      
      // Resolve local files before calling sendXmppMedia (which only handles network)
      let resolvedMedia: import("./outbound.js").ResolvedMedia | undefined;
      try {
        const url = new URL(mediaUrl);
        if (url.protocol === "file:") {
          const { readFileUrl } = await import("./file-read.js");
          resolvedMedia = readFileUrl(mediaUrl, log);
        }
      } catch {
        // Not a valid URL — treat as local file path
        const { readLocalFile } = await import("./file-read.js");
        const result = readLocalFile(mediaUrl, log);
        if (!result) {
          log?.error?.(`[XMPP] File not found: ${mediaUrl}`);
          continue;
        }
        resolvedMedia = result;
      }
      
      const result = await sendXmppMedia(config, replyTo, mediaUrl, caption, {
        log,
        accountId,
        resolvedMedia,
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

  // Check if we should encrypt the reply
  // Encrypt if: OMEMO enabled AND (DM OR OMEMO-capable MUC)
  // When OMEMO is enabled, ALL outbound messages must be encrypted.
  const omemoEnabled = isOmemoEnabled(accountId);
  const shouldEncryptDm = !message.isGroup && omemoEnabled;
  const shouldEncryptMuc = message.isGroup && omemoEnabled && isRoomOmemoCapable(accountId, bareJid(replyTo));
  
  if (shouldEncryptDm) {
    // Encrypt with OMEMO for DMs
    const recipientJid = message.senderJidForOmemo || bareJid(senderIdentity);
    log?.debug?.(`[XMPP] Encrypting reply with OMEMO for ${recipientJid}`);
    
    try {
      const encryptedElement = await encryptOmemoMessage(accountId, recipientJid, textToSend, log);
      if (encryptedElement) {
        const encryptedStanza = buildOmemoMessageStanza(replyTo, encryptedElement, "chat");
        log?.debug?.(`[XMPP] Sending OMEMO encrypted reply to ${replyTo}`);
        await xmppClient.send(encryptedStanza);
        log?.info?.(`[XMPP] Successfully sent OMEMO encrypted reply to ${replyTo}`);
        
        // Update lastOutboundAt and clear typing indicator
        setStatus?.({ accountId, lastOutboundAt: Date.now() });
        await sendChatState(accountId, replyTo, "active", log);
        return;
      } else {
        log?.warn?.(`[XMPP] OMEMO encryption failed for DM, sending warning instead of plaintext reply`);
        const warningStanza = xml(
          "message",
          { to: replyTo, type: "chat", id: generateMessageId() },
          xml("body", {}, "⚠️ Failed to encrypt reply (OMEMO encryption returned empty). Message not sent for security.")
        );
        await xmppClient.send(warningStanza);
        await sendChatState(accountId, replyTo, "active", log);
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error?.(`[XMPP] OMEMO encryption error: ${errMsg}, sending warning instead of plaintext reply`);
      const warningStanza = xml(
        "message",
        { to: replyTo, type: "chat", id: generateMessageId() },
        xml("body", {}, `⚠️ Failed to encrypt reply: ${errMsg}. Message not sent for security.`)
      );
      await xmppClient.send(warningStanza);
      await sendChatState(accountId, replyTo, "active", log);
      return;
    }
  } else if (shouldEncryptMuc) {
    // Encrypt with OMEMO for MUC rooms
    const roomJid = bareJid(replyTo);
    log?.debug?.(`[XMPP] Encrypting MUC reply with OMEMO for room ${roomJid}`);
    
    try {
      const encryptedElement = await encryptMucOmemoMessage(accountId, roomJid, textToSend, log);
      if (encryptedElement) {
        const encryptedStanza = buildOmemoMessageStanza(replyTo, encryptedElement, "groupchat");
        log?.debug?.(`[XMPP] Sending MUC OMEMO encrypted reply to ${replyTo}`);
        await xmppClient.send(encryptedStanza);
        log?.info?.(`[XMPP] Successfully sent MUC OMEMO encrypted reply to ${replyTo}`);
        
        // Update lastOutboundAt and clear typing indicator
        setStatus?.({ accountId, lastOutboundAt: Date.now() });
        await sendChatState(accountId, replyTo, "active", log);
        return;
      } else {
        log?.warn?.(`[XMPP] MUC OMEMO encryption failed, sending warning instead of plaintext reply`);
        const warningStanza = xml(
          "message",
          { to: replyTo, type: "groupchat", id: generateMessageId() },
          xml("body", {}, "⚠️ Failed to encrypt reply (OMEMO encryption returned empty). Message not sent for security.")
        );
        await xmppClient.send(warningStanza);
        await sendChatState(accountId, replyTo, "active", log);
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error?.(`[XMPP] MUC OMEMO encryption error: ${errMsg}, sending warning instead of plaintext reply`);
      const warningStanza = xml(
        "message",
        { to: replyTo, type: "groupchat", id: generateMessageId() },
        xml("body", {}, `⚠️ Failed to encrypt reply: ${errMsg}. Message not sent for security.`)
      );
      await xmppClient.send(warningStanza);
      await sendChatState(accountId, replyTo, "active", log);
      return;
    }
  }

  // Build reply message with XEP-0461 (Message Replies) for proper threading
  const messageId = generateMessageId();
  const originalMsgId = message.id;
  // XEP-0461: for groups, use full occupant JID (room/nick); for DMs, use bare JID
  const originalSender = senderIdentity;
  
  // XEP-0461: reply element references the original message
  const replyChildren: ReturnType<typeof xml>[] = [xml("body", {}, textToSend)];
  
  // Add XEP-0461 reply reference if we have the original message ID
  if (originalMsgId) {
    replyChildren.push(
      xml("reply", { xmlns: "urn:xmpp:reply:0", to: originalSender, id: originalMsgId })
    );
  }
  
  const reply = xml(
    "message",
    { to: replyTo, type: msgType, id: messageId },
    ...replyChildren
  );

  log?.debug?.(`[XMPP] Sending stanza: to=${replyTo} type=${msgType} id=${messageId} replyTo=${originalMsgId || "none"}`);

  try {
    await xmppClient.send(reply);
    log?.info?.(`[XMPP] Successfully sent reply to ${replyTo}: ${textToSend.slice(0, 100)}...`);
  } catch (err) {
    log?.error?.(`[XMPP] Failed to send reply: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  // Update lastOutboundAt and clear typing indicator
  setStatus?.({ accountId, lastOutboundAt: Date.now() });
  await sendChatState(accountId, replyTo, "active", log);
}

/**
 * Handle inbound XMPP reaction (XEP-0444)
 * Routes inbound reactions to OpenClaw so the AI can see and process them
 */
export async function handleInboundReaction(params: {
  reactedMessageId: string;
  emojis: string[];
  senderBare: string;
  senderFull: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
  cfg: unknown;
  accountId: string;
  config: XmppConfig;
  log?: Logger;
  setStatus?: (patch: ChannelAccountStatusPatch) => void;
}): Promise<void> {
  const {
    reactedMessageId,
    emojis,
    senderBare,
    senderFull,
    isGroup,
    roomJid,
    senderNick,
    cfg,
    accountId,
    config,
    log,
    setStatus,
  } = params;

  const rt = getXmppRuntime();

  // Update last inbound timestamp
  setStatus?.({
    accountId,
    lastInboundAt: Date.now(),
  });

  // For reactions, we need to check if the sender is allowed
  const allowFromList = normalizeAllowFrom(config.allowFrom);
  const isOwner = isSenderAllowed(allowFromList, senderBare);

  if (isGroup) {
    // For groups: check groupPolicy first
    const groupPolicy = config.groupPolicy ?? "open";

    if (groupPolicy === "open") {
      log?.debug?.(`[XMPP] Group reaction allowed (groupPolicy: open)`);
    } else {
      const groupAllowList = normalizeAllowFrom(config.groupAllowFrom ?? config.allowFrom);
      if (!isSenderAllowed(groupAllowList, senderBare)) {
        log?.debug?.(`[XMPP] Group reaction blocked: ${senderBare} not in groupAllowFrom`);
        return;
      }
    }
  } else {
    // For direct chats: owners (allowFrom) always have access
    if (!isOwner) {
      const dmPolicy = config.dmPolicy ?? "open";

      if (dmPolicy === "disabled") {
        log?.debug?.(`[XMPP] Direct chat reaction blocked (dmPolicy: disabled, guest ${senderBare})`);
        return;
      } else if (dmPolicy === "allowlist") {
        const dmAllowList = normalizeAllowFrom(config.dmAllowlist);
        if (!isSenderAllowed(dmAllowList, senderBare)) {
          log?.debug?.(`[XMPP] Direct chat reaction blocked: guest ${senderBare} not in dmAllowlist`);
          return;
        }
      }
    }
  }

  // For groups, sender identity is the full occupant JID; for DMs, it's the bare JID
  const senderIdentity = isGroup ? senderFull : senderBare;

  log?.info?.(`[XMPP] Inbound reaction: from=${senderIdentity} emojis="${emojis.join(", ")}" onMessage=${reactedMessageId}`);

  // Create a special body that the AI can understand as a reaction
  // Format: "[reaction] 👋 on your message"
  const reactionText = `[reaction] ${emojis.join(" ")} on your message "${reactedMessageId}"`;
  
  // DEBUG: Log what we're sending to the AI
  log?.info?.(`[XMPP] Reaction text for AI: ${reactionText}`);
  log?.info?.(`[XMPP] Providing ReactedMessageId=${reactedMessageId} for AI to use when reacting back`);

  // Route to OpenClaw (same as regular messages)
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: "xmpp",
    accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? roomJid! : senderBare,
    },
  });

  const storePath = rt.channel.session.resolveStorePath(
    (cfg as { session?: { store?: string } }).session?.store,
    { agentId: route.agentId }
  );

  // Build the context with reaction info
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: reactionText,
    RawBody: reactionText,
    CommandBody: reactionText,
    From: `xmpp:${senderIdentity}`,
    To: `xmpp:${config.jid}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: isGroup ? roomJid : senderBare,
    SenderName: senderNick || senderBare.split("@")[0],
    SenderId: senderIdentity,
    Provider: "xmpp",
    Surface: "xmpp",
    MessageSid: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    OriginatingChannel: "xmpp" as const,
    OriginatingTo: `xmpp:${isGroup ? roomJid : senderBare}`,
    CommandAuthorized: isOwner || (config.dmPolicy ?? "open") === "open",
    // Include reaction-specific metadata
    ReactionEmojis: emojis,
    ReactedMessageId: reactedMessageId,
    IsReaction: true,
  });

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey ?? route.sessionKey,
    ctx,
    updateLastRoute: isGroup ? undefined : {
      sessionKey: route.mainSessionKey,
      channel: "xmpp",
      to: senderBare,
      accountId,
    },
    onRecordError: (err: unknown) => {
      log?.error?.(`[XMPP] Failed to record inbound reaction session: ${String(err)}`);
    },
  });

  log?.info?.(`[XMPP] Reaction dispatching to AI...`);
  
  // Dispatch reaction to AI for processing
  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async () => {
        log?.debug?.(`[XMPP] Reaction deliver callback (no auto-reply for reactions)`);
      },
    },
  });

  log?.info?.(`[XMPP] Reaction dispatch completed`);
}
