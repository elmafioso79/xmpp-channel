/**
 * XMPP Connection Monitor
 * 
 * Main entry point for XMPP connection management.
 * Handles connection lifecycle, message routing, and event dispatch.
 */

import { client, xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import { createRequire } from "module";
import type { XmppConfig, GatewayStartContext, XmppInboundMessage, Logger } from "./types.js";
import { resolveServer, extractUsername, bareJid, resolveCredentialReference } from "./config-schema.js";
import { parsePepEvent, type PepItem } from "./pep.js";

// Import from split modules
import {
  activeClients,
  reconnectStates,
  RECONNECT_BASE_DELAY_MS,
  cleanupAccountState,
  sentMessageIds,
} from "./state.js";
import { joinMuc, getPersistedRooms } from "./rooms.js";
import { startKeepalive, stopKeepalive } from "./keepalive.js";
import {
  registerStartXmppConnection,
  initReconnectState,
  clearReconnectState,
  abortReconnect,
  scheduleReconnect,
} from "./reconnect.js";
import { sendChatState, sendChatMarker } from "./chat-state.js";
import { setupPresenceHandlers, setupMucInviteHandler } from "./stanza-handlers.js";
import { setupIqHandlers } from "./iq-handlers.js";
import { handleInboundMessage, handleInboundReaction } from "./inbound.js";

// OMEMO imports
import {
  initializeOmemo,
  isOmemoEnabled,
  isOmemoEncrypted,
  decryptOmemoMessage,
  shutdownOmemo,
  handleDeviceListPepEvent,
} from "./omemo/index.js";

const require = createRequire(import.meta.url);
const xmppXml = require("@xmpp/xml") as {
  Parser: new () => {
    on: (event: string, listener: (arg: unknown) => void) => void;
    end: (input?: string) => void;
  };
};

const NS_SCE = "urn:xmpp:sce:1";
const NS_REACTIONS = "urn:xmpp:reactions:0";
const MAX_REACTION_ID_LENGTH = 256;

function parseXmlElement(xmlPayload: string): Element | null {
  try {
    const parser = new xmppXml.Parser();
    let root: Element | null = null;
    let failed = false;
    parser.on("start", (element) => {
      root = element as Element;
    });
    parser.on("end", (element) => {
      root = element as Element;
    });
    parser.on("error", () => {
      failed = true;
    });
    parser.end(xmlPayload);
    if (failed) return null;
    return root;
  } catch {
    return null;
  }
}

function sanitizeReactionMessageId(rawId: string | undefined): string | null {
  const normalized = String(rawId ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (!normalized || normalized.length > MAX_REACTION_ID_LENGTH) {
    return null;
  }
  return normalized;
}

function parseSceWrappedReaction(body: string): { reactedMessageId: string; emojis: string[] } | null {
  if (!body.includes("<envelope") || !body.includes(NS_SCE)) {
    return null;
  }
  const envelope = parseXmlElement(body);
  if (!envelope) return null;
  if (envelope.name !== "envelope") return null;
  if (envelope.attrs?.xmlns !== NS_SCE) return null;

  const content = envelope.getChild("content", NS_SCE) ?? envelope.getChild("content");
  if (!content) return null;
  const reactions = content.getChild("reactions", NS_REACTIONS) ?? content.getChild("reactions");
  if (!reactions) return null;

  const reactedMessageId = sanitizeReactionMessageId(reactions.attrs?.id);
  if (!reactedMessageId) return null;

  const emojis = reactions
    .getChildren("reaction")
    .map((reaction) => String(reaction.text?.() ?? "").trim())
    .filter(Boolean);

  return { reactedMessageId, emojis };
}

// =============================================================================
// RE-EXPORTS for backward compatibility
// =============================================================================

export { cleanupAccountState } from "./state.js";
export { sendChatState, sendChatMarker } from "./chat-state.js";

// =============================================================================
// PEP EVENT HANDLERS
// =============================================================================

type PepEventHandler = (event: {
  accountId: string;
  from: string;
  node: string;
  items: PepItem[];
  retracted: string[];
  log?: Logger;
}) => void | Promise<void>;

const pepEventHandlers: PepEventHandler[] = [];

/**
 * Register a PEP event handler
 */
export function registerPepEventHandler(handler: PepEventHandler): void {
  pepEventHandlers.push(handler);
}

/**
 * Unregister a PEP event handler
 */
export function unregisterPepEventHandler(handler: PepEventHandler): void {
  const index = pepEventHandlers.indexOf(handler);
  if (index !== -1) {
    pepEventHandlers.splice(index, 1);
  }
}

// =============================================================================
// REGISTER OMEMO PEP HANDLERS
// =============================================================================

// Register the device list PEP handler for OMEMO multi-device sync
// This is registered globally and handles events for all accounts
registerPepEventHandler(handleDeviceListPepEvent);

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate unique session ID for XMPP resource (prevents connection conflicts on restart)
 */
function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

/**
 * Get active client for an account
 */
export function getActiveClient(accountId: string): ReturnType<typeof client> | undefined {
  return activeClients.get(accountId);
}

// =============================================================================
// MAIN CONNECTION FUNCTION
// =============================================================================

/**
 * Start XMPP connection for an account
 * Returns a promise that stays pending until the connection is stopped
 */
export async function startXmppConnection(ctx: GatewayStartContext): Promise<void> {
  const { account, cfg, abortSignal, log, setStatus } = ctx;
  const accountId = ctx.accountId ?? account.accountId ?? "default";
  const config = account.config;

  log?.debug?.(`[${accountId}] Gateway context: hasSetStatus=${!!setStatus}`);

  if (!config.jid || !config.password) {
    throw new Error("XMPP jid and password are required");
  }

  const server = resolveServer(config);
  const username = extractUsername(config.jid);
  const resolvedPassword = resolveCredentialReference(config.password);
  
  // Generate unique resource per session to prevent connection conflicts on restart
  const sessionResource = config.resource ?? `openclaw-${generateSessionId()}`;
  
  // Nickname is what users see in group chats
  const nickname = config.nickname ?? username;

  log?.info?.(`[${accountId}] Starting XMPP connection to ${server} (resource=${sessionResource}, nickname=${nickname})...`);

  // Mark as starting
  if (setStatus) {
    log?.debug?.(`[${accountId}] setStatus: running=true`);
    setStatus({
      accountId,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    });
  } else {
    log?.error?.(`[${accountId}] XMPP ERROR: setStatus function not provided by OpenClaw!`);
  }

  const credentials = async (
    authenticate: (creds: { username: string; password: string }) => Promise<void>,
    mechanism?: string,
  ) => {
    const selected = String(mechanism ?? "").toUpperCase();
    if (selected === "PLAIN" && config.allowSaslPlain !== true) {
      throw new Error("Server selected SASL PLAIN; set channels.xmpp.allowSaslPlain=true to allow");
    }
    if (selected === "ANONYMOUS") {
      throw new Error("Refusing SASL ANONYMOUS for authenticated XMPP account");
    }
    await authenticate({ username, password: resolvedPassword });
  };

  const xmpp = client({
    service: `xmpp://${server}:${config.port ?? 5222}`,
    domain: server,
    username,
    password: resolvedPassword,
    credentials,
    resource: sessionResource,
  } as unknown as Parameters<typeof client>[0]);

  // Store client for outbound messaging
  activeClients.set(accountId, xmpp);

  // XEP-0198 Stream Management event handlers
  const streamManagement = (xmpp as unknown as { streamManagement?: {
    on?: (event: string, handler: (stanza?: Element) => void) => void;
  } }).streamManagement;
  
  if (streamManagement && typeof streamManagement.on === "function") {
    streamManagement.on("resumed", () => {
      log?.info?.(`[${accountId}] XEP-0198 Stream Management: session resumed`);
      setStatus?.({ accountId, connected: true, lastConnectedAt: Date.now() });
    });
    
    streamManagement.on("fail", (stanza) => {
      log?.warn?.(`[${accountId}] XEP-0198 Stream Management: stanza failed to send: ${stanza?.toString()?.slice(0, 100)}`);
    });
    
    streamManagement.on("ack", () => {
      log?.debug?.(`[${accountId}] XEP-0198 Stream Management: stanza acknowledged`);
    });
  }

  // Setup message stanza handler
  setupMessageHandler(xmpp, accountId, nickname, cfg, config, log, setStatus);

  // Setup presence handlers (subscriptions, MUC self-presence, errors)
  setupPresenceHandlers(xmpp, accountId, config, log);

  // Setup MUC invite handler
  setupMucInviteHandler(xmpp, accountId, nickname, config, log);

  // Setup IQ handlers (XEP-0092 version, XEP-0202 time)
  setupIqHandlers(xmpp, accountId, log);

  // Connection events
  xmpp.on("online", async (address) => {
    log?.info?.(`[${accountId}] XMPP online as ${address.toString()}`);
    
    // Start XEP-0199 keepalive pings
    startKeepalive(xmpp, accountId, server, log);
    
    // Enable XEP-0280 Message Carbons
    try {
      const enableCarbons = xml(
        "iq",
        { type: "set", id: `carbons-${Date.now()}` },
        xml("enable", { xmlns: "urn:xmpp:carbons:2" })
      );
      await xmpp.send(enableCarbons);
      log?.debug?.(`[${accountId}] XEP-0280 Message Carbons enabled`);
    } catch (err) {
      log?.warn?.(`[${accountId}] Failed to enable carbons: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Send initial presence
    const initialPresence = xml("presence", {}, 
      xml("status", {}, "OpenClaw Bot Online"),
      xml("priority", {}, "1")
    );
    try {
      await xmpp.send(initialPresence);
      log?.debug?.(`[${accountId}] XMPP initial presence sent`);
    } catch (err) {
      log?.error?.(`[${accountId}] XMPP failed to send initial presence: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Mark as connected
    setStatus?.({
      accountId,
      running: true,
      connected: true,
      lastConnectedAt: Date.now(),
      lastError: null,
    });

    // Initialize OMEMO if enabled
    if (config.omemo?.enabled) {
      try {
        await initializeOmemo(accountId, config.jid, config.omemo.deviceLabel, log, {
          maxDevicesPerJid: config.omemo.maxDevicesPerJid,
        });
      } catch (err) {
        log?.error?.(`[${accountId}] OMEMO initialization failed: ${err instanceof Error ? err.message : String(err)}`);
        // Continue without OMEMO - non-fatal
      }
    }

    // Debug: log config for troubleshooting
    log?.debug?.(`[${accountId}] Config debug: allowFrom=${JSON.stringify(config.allowFrom)} groups=${JSON.stringify(config.groups)} dmPolicy=${config.dmPolicy}`);

    // Join group chat rooms from config
    if (config.groups && config.groups.length > 0) {
      log?.info?.(`[${accountId}] Joining ${config.groups.length} group rooms...`);
      for (const room of config.groups) {
        await joinMuc(xmpp, room, nickname, log, accountId, true);
      }
    } else {
      log?.debug?.(`[${accountId}] No group rooms configured`);
    }
    
    // Join persisted rooms (from previous invites)
    const persistedRooms = getPersistedRooms(accountId, log);
    for (const roomJid of persistedRooms) {
      if (config.groups?.includes(roomJid)) continue;
      log?.info?.(`[${accountId}] Rejoining persisted room: ${roomJid}`);
      await joinMuc(xmpp, roomJid, nickname, log, accountId, true);
    }
  });

  xmpp.on("offline", () => {
    log?.info?.(`[${accountId}] XMPP offline`);
    
    stopKeepalive(accountId);
    
    setStatus?.({
      accountId,
      running: true,
      connected: false,
      lastDisconnect: Date.now(),
    });
    
    const reconnectState = reconnectStates.get(accountId);
    if (!reconnectState?.aborted) {
      scheduleReconnect(accountId, ctx, log);
    }
  });

  xmpp.on("error", (err) => {
    log?.error?.(`[${accountId}] XMPP error: ${err.message}`);
    setStatus?.({ accountId, lastError: err.message });
  });

  // Start connection
  try {
    await xmpp.start();
    clearReconnectState(accountId);
  } catch (err) {
    log?.error?.(`[${accountId}] XMPP connection failed: ${err instanceof Error ? err.message : String(err)}`);
    setStatus?.({ accountId, lastError: err instanceof Error ? err.message : String(err) });
    scheduleReconnect(accountId, ctx, log);
  }

  // Return a promise that stays pending until the connection is stopped
  return new Promise<void>((resolve) => {
    initReconnectState(accountId);
    
    const cleanup = () => {
      const state = reconnectStates.get(accountId);
      if (state?.aborted) return;
      
      abortReconnect(accountId);
      
      log?.info?.(`[${accountId}] Stopping XMPP connection...`);
      
      stopKeepalive(accountId);
      
      // Shutdown OMEMO
      shutdownOmemo(accountId, log).catch((err) => {
        log?.warn?.(`[${accountId}] OMEMO shutdown error: ${err}`);
      });
      
      xmpp.stop();
      activeClients.delete(accountId);
      
      setStatus?.({
        accountId,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
      
      resolve();
    };

    abortSignal?.addEventListener("abort", cleanup);
  });
}

// Register this function for reconnect module (avoids circular dependency)
registerStartXmppConnection(startXmppConnection);

// =============================================================================
// MESSAGE STANZA HANDLER
// =============================================================================

function setupMessageHandler(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  nickname: string,
  cfg: unknown,
  config: XmppConfig,
  log?: Logger,
  setStatus?: GatewayStartContext["setStatus"]
): void {
  xmpp.on("stanza", async (stanza) => {
    log?.debug?.(`[${accountId}] XMPP stanza received: attrs=${JSON.stringify(stanza.attrs)}`);
    
    if (!stanza.is("message")) return;

    // Check for PEP events first
    const pepEvent = parsePepEvent(stanza as Element);
    if (pepEvent) {
      log?.debug?.(`[${accountId}] PEP event from ${pepEvent.from}: node=${pepEvent.node}, items=${pepEvent.items.length}`);
      for (const handler of pepEventHandlers) {
        try {
          await handler({
            accountId,
            from: pepEvent.from,
            node: pepEvent.node,
            items: pepEvent.items,
            retracted: pepEvent.retracted,
            log,
          });
        } catch (err) {
          log?.error?.(`[${accountId}] PEP handler error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    // Early check for MUC self-messages (before OMEMO decryption to avoid pointless decrypt attempts)
    const from = stanza.attrs.from;
    const type = stanza.attrs.type || "chat";
    const isGroupchat = type === "groupchat";    
    // Check if this is our own message (from our JID) - this is a carbon copy of our sent message
    // The server assigns a stanza-id that clients use for reactions
    const ourJid = config.jid;
    const isOurOwnMessage = from && bareJid(from) === bareJid(ourJid);
    
    if (isGroupchat) {
      const senderNickFromFrom = from.split("/")[1];
      if (senderNickFromFrom === nickname) {
        log?.debug?.(`[${accountId}] XMPP skipping self-message in group (nick=${senderNickFromFrom})`);
        return;
      }
    }

    // Early check for history messages (before OMEMO decryption to avoid pointless decrypt attempts on old messages)
    const delay = stanza.getChild("delay", "urn:xmpp:delay") || stanza.getChild("x", "jabber:x:delay");
    if (delay) {
      log?.debug?.(`[${accountId}] XMPP skipping history message (has delay element)`);
      return;
    }

    // If this is our own message (carbon copy), capture the server-assigned stanza-id
    // This is needed for reactions - users react to the server's ID of our sent messages
    if (isOurOwnMessage) {
      const stanzaIdEl = stanza.getChild("stanza-id", "urn:xmpp:sid:0");
      const serverMsgId = stanzaIdEl?.attrs?.id;
      const clientMsgId = stanza.attrs.id;
      
      if (serverMsgId && clientMsgId) {
        // Store mapping: server-side ID -> for later lookup
        // This helps us understand what users are reacting to
        const mapKey = `${accountId}:sent:${serverMsgId}`;
        sentMessageIds.set(mapKey, clientMsgId);
        log?.debug?.(`[${accountId}] Stored sent message mapping: server=${serverMsgId} -> client=${clientMsgId}`);
        
        // Also store the reverse mapping: client ID -> server ID
        const reverseKey = `${accountId}:${clientMsgId}`;
        sentMessageIds.set(reverseKey, serverMsgId);
        log?.debug?.(`[${accountId}] Stored reverse mapping: client=${clientMsgId} -> server=${serverMsgId}`);
        
        // Schedule cleanup after 5 minutes
        setTimeout(() => {
          sentMessageIds.delete(mapKey);
          sentMessageIds.delete(reverseKey);
        }, 5 * 60 * 1000);
      }
      
      // Skip processing our own messages - they're just carbon copies
      log?.debug?.(`[${accountId}] XMPP skipping our own message (carbon copy)`);
      return;
    }

    // Check for OMEMO encrypted message
    let body: string | null = null;
    let wasEncrypted = false;
    
    // Detect if this stanza is OMEMO-encrypted (either via <encrypted> element or EME hint)
    const hasOmemoEncryption = isOmemoEncrypted(stanza as Element);
    const emeHint = stanza.getChild("encryption", "urn:xmpp:eme:0");
    const isOmemoStanza = hasOmemoEncryption || emeHint?.attrs?.name === "OMEMO";
    
    if (isOmemoEnabled(accountId) && hasOmemoEncryption) {
      log?.debug?.(`[${accountId}] OMEMO encrypted message detected`);
      try {
        body = await decryptOmemoMessage(accountId, stanza as Element, log);
        if (body) {
          wasEncrypted = true;
          log?.debug?.(`[${accountId}] OMEMO decryption successful`);
          
          // XEP-0444 + XEP-0420: Check if decrypted payload contains SCE-wrapped reactions
          try {
            const parsedReaction = parseSceWrappedReaction(body);
            if (parsedReaction) {
              log?.debug?.(`[${accountId}] Parsed SCE-wrapped reaction payload`);
              const senderBare = bareJid(from);
              if (parsedReaction.emojis.length > 0) {
                log?.info?.(
                  `[${accountId}] XEP-0444 OMEMO-encrypted reaction from ${senderBare}: ${parsedReaction.emojis.join(", ")} on message ${parsedReaction.reactedMessageId}`,
                );
              } else {
                log?.info?.(
                  `[${accountId}] XEP-0444 OMEMO-encrypted reaction removed by ${senderBare} on message ${parsedReaction.reactedMessageId}`,
                );
              }

              const roomJid = isGroupchat ? bareJid(from) : undefined;
              const senderNick = isGroupchat ? from.split("/")[1] : undefined;

              await handleInboundReaction({
                reactedMessageId: parsedReaction.reactedMessageId,
                emojis: parsedReaction.emojis,
                senderBare,
                senderFull: from,
                isGroup: isGroupchat,
                roomJid,
                senderNick,
                cfg,
                accountId,
                config,
                log,
                setStatus,
              });

              // Reaction processed - don't continue with normal message handling
              return;
            }
          } catch (sceErr) {
            log?.warn?.(`[${accountId}] Failed to parse SCE envelope: ${sceErr}`);
          }
        } else {
          log?.debug?.(`[${accountId}] OMEMO decryption returned null (message not for us or key transport)`);
        }
      } catch (err) {
        log?.warn?.(`[${accountId}] OMEMO decryption error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    // If the stanza was OMEMO-encrypted (or has EME hint), NEVER fall back to
    // the plaintext <body>. That body is just a fallback notice for non-OMEMO
    // clients (e.g. "I sent you an OMEMO encrypted message but your client
    // doesn't seem to support that."). Processing it as real content causes
    // the AI to "complain" about unreadable messages at session start.
    if (!body && !isOmemoStanza) {
      body = stanza.getChildText("body");
    } else if (!body && isOmemoStanza) {
      log?.debug?.(`[${accountId}] OMEMO message could not be decrypted, ignoring fallback body`);
    }
    
    log?.debug?.(`[${accountId}] XMPP message stanza: body=${body ? `"${body.slice(0, 50)}"` : "null"} encrypted=${wasEncrypted}`);

    // XEP-0444: Detect incoming reactions (reactions have no body)
    const reactionsEl = stanza.getChild("reactions", "urn:xmpp:reactions:0");
    if (reactionsEl) {
      const reactedMsgId = sanitizeReactionMessageId(reactionsEl.attrs.id);
      if (!reactedMsgId) {
        log?.warn?.(`[${accountId}] Ignoring reaction with missing/invalid message id from ${from}`);
        return;
      }
      const reactionChildren = reactionsEl.getChildren("reaction");
      const emojis = reactionChildren.map((r) => r.text?.() ?? "").filter(Boolean);
      const senderBare = bareJid(from);
      
      // Determine if this is a groupchat or direct message
      const roomJid = isGroupchat ? bareJid(from) : undefined;
      const senderNick = isGroupchat ? from.split("/")[1] : undefined;
      
      if (emojis.length > 0) {
        log?.info?.(`[${accountId}] XEP-0444 reaction from ${senderBare}: ${emojis.join(", ")} on message ${reactedMsgId}`);
      } else {
        log?.info?.(`[${accountId}] XEP-0444 reaction removed by ${senderBare} on message ${reactedMsgId}`);
      }
      
      log?.info?.(`[${accountId}] XEP-0444 Routing reaction to OpenClaw...`);
      
      // Route reaction to OpenClaw so the AI can see and process it
      await handleInboundReaction({
        reactedMessageId: reactedMsgId || "",
        emojis,
        senderBare,
        senderFull: from,
        isGroup: isGroupchat,
        roomJid,
        senderNick,
        cfg,
        accountId,
        config,
        log,
        setStatus,
      });
      
      log?.info?.(`[${accountId}] XEP-0444 Reaction routing completed`);
      
      // Reactions don't have a body — skip normal message processing
      return;
    }
    
    if (!body) return;

    // History check already done earlier (before OMEMO decryption)

    const to = stanza.attrs.to;
    const id = stanza.attrs.id || `msg_${Date.now()}`;

    let senderJid = from;
    let roomJid: string | undefined;
    let senderNick: string | undefined;

    if (isGroupchat) {
      roomJid = bareJid(from);
      senderNick = from.split("/")[1];
      // Self-message check already done earlier (before OMEMO decryption)
    }

    log?.info?.(`[${accountId}] XMPP inbound message: from=${from} type=${type}`);

    // XEP-0461: Parse reply context
    let replyToId: string | undefined;
    let replyToBody: string | undefined;
    
    const replyElement = stanza.getChild("reply", "urn:xmpp:reply:0");
    if (replyElement) {
      replyToId = replyElement.attrs.id;
      log?.debug?.(`[${accountId}] XEP-0461 reply to message: ${replyToId}`);
      
      const fallbackElement = stanza.getChild("fallback", "urn:xmpp:fallback:0");
      if (fallbackElement && body) {
        const lines = body.split("\n");
        const quotedLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith(">")) {
            quotedLines.push(line.slice(1).trim());
          } else {
            break;
          }
        }
        if (quotedLines.length > 0) {
          replyToBody = quotedLines.join("\n");
        }
      }
    }

    const message: XmppInboundMessage = {
      id,
      from: senderJid,
      to,
      body,
      type: type as XmppInboundMessage["type"],
      timestamp: Date.now(),
      isGroup: isGroupchat,
      roomJid,
      senderNick,
      replyToId,
      replyToBody,
      // XEP-0359: Capture server-assigned stanza-id (preferred for reactions/references)
      // For MUC: MUST use stanza-id with 'by' attribute matching room JID (per XEP-0444)
      // For DMs: Use stanza-id or fall back to stanza's 'id' attribute
      stanzaId: (() => {
        const stanzaIdEl = stanza.getChild("stanza-id", "urn:xmpp:sid:0");
        if (stanzaIdEl?.attrs?.id) {
          // For MUC, verify the 'by' attribute matches the room JID
          if (isGroupchat && roomJid) {
            const byAttr = stanzaIdEl.attrs.by;
            if (byAttr && bareJid(byAttr) === bareJid(roomJid)) {
              return stanzaIdEl.attrs.id;
            }
          }
          return stanzaIdEl.attrs.id;
        }
        return stanza.attrs.id || undefined;
      })(),
      // Raw stanza 'id' attribute (some clients like Gajim use this directly)
      rawStanzaId: stanza.attrs.id,
      wasEncrypted,
      // For MUC, we need the actual sender JID for OMEMO encryption
      // This is extracted from the stanza's 'from' attribute before we modified senderJid
      senderJidForOmemo: bareJid(from),
    };

    await handleInboundMessage(message, cfg, accountId, config, log, setStatus);
  });
}
