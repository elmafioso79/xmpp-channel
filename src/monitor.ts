/**
 * XMPP Connection Monitor
 * 
 * Main entry point for XMPP connection management.
 * Handles connection lifecycle, message routing, and event dispatch.
 */

import { client, xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import type { XmppConfig, GatewayStartContext, XmppInboundMessage, Logger } from "./types.js";
import { resolveServer, extractUsername, bareJid } from "./config-schema.js";
import { parsePepEvent, type PepItem } from "./pep.js";

// Import from split modules
import {
  activeClients,
  reconnectStates,
  RECONNECT_BASE_DELAY_MS,
  cleanupAccountState,
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
import { handleInboundMessage } from "./inbound.js";

// OMEMO imports
import {
  initializeOmemo,
  isOmemoEnabled,
  isOmemoEncrypted,
  decryptOmemoMessage,
  shutdownOmemo,
  handleDeviceListPepEvent,
} from "./omemo/index.js";

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
  
  // Generate unique resource per session to prevent connection conflicts on restart
  const sessionResource = config.resource ?? `openclaw-${generateSessionId()}`;
  
  // MUC nick is what users see in group chats
  const mucNick = config.mucNick ?? username;

  log?.info?.(`[${accountId}] Starting XMPP connection to ${server} (resource=${sessionResource}, mucNick=${mucNick})...`);

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

  const xmpp = client({
    service: `xmpp://${server}:${config.port ?? 5222}`,
    domain: server,
    username,
    password: config.password,
    resource: sessionResource,
  });

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
  setupMessageHandler(xmpp, accountId, mucNick, cfg, config, log, setStatus);

  // Setup presence handlers (subscriptions, MUC self-presence, errors)
  setupPresenceHandlers(xmpp, accountId, log);

  // Setup MUC invite handler
  setupMucInviteHandler(xmpp, accountId, mucNick, log);

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
        await initializeOmemo(accountId, config.jid, config.omemo.deviceLabel, log);
      } catch (err) {
        log?.error?.(`[${accountId}] OMEMO initialization failed: ${err instanceof Error ? err.message : String(err)}`);
        // Continue without OMEMO - non-fatal
      }
    }

    // Debug: log config for troubleshooting
    log?.debug?.(`[${accountId}] Config debug: allowFrom=${JSON.stringify(config.allowFrom)} mucs=${JSON.stringify(config.mucs)} dmPolicy=${config.dmPolicy} dms=${JSON.stringify(config.dms)}`);

    // Join MUC rooms from config
    if (config.mucs && config.mucs.length > 0) {
      log?.info?.(`[${accountId}] Joining ${config.mucs.length} MUC rooms...`);
      for (const muc of config.mucs) {
        await joinMuc(xmpp, muc, mucNick, log, accountId, true);
      }
    } else {
      log?.debug?.(`[${accountId}] No MUC rooms configured`);
    }
    
    // Join persisted rooms (from previous invites)
    const persistedRooms = getPersistedRooms(accountId, log);
    for (const roomJid of persistedRooms) {
      if (config.mucs?.includes(roomJid)) continue;
      log?.info?.(`[${accountId}] Rejoining persisted room: ${roomJid}`);
      await joinMuc(xmpp, roomJid, mucNick, log, accountId, true);
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
  mucNick: string,
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
    if (isGroupchat) {
      const senderNickFromFrom = from.split("/")[1];
      if (senderNickFromFrom === mucNick) {
        log?.debug?.(`[${accountId}] XMPP skipping self-message in MUC (nick=${senderNickFromFrom})`);
        return;
      }
    }

    // Early check for history messages (before OMEMO decryption to avoid pointless decrypt attempts on old messages)
    const delay = stanza.getChild("delay", "urn:xmpp:delay") || stanza.getChild("x", "jabber:x:delay");
    if (delay) {
      log?.debug?.(`[${accountId}] XMPP skipping history message (has delay element)`);
      return;
    }

    // Check for OMEMO encrypted message
    let body: string | null = null;
    let wasEncrypted = false;
    
    if (isOmemoEnabled(accountId) && isOmemoEncrypted(stanza as Element)) {
      log?.debug?.(`[${accountId}] OMEMO encrypted message detected`);
      try {
        body = await decryptOmemoMessage(accountId, stanza as Element, log);
        if (body) {
          wasEncrypted = true;
          log?.debug?.(`[${accountId}] OMEMO decryption successful`);
        } else {
          log?.debug?.(`[${accountId}] OMEMO decryption returned null (message not for us or key transport)`);
        }
      } catch (err) {
        log?.warn?.(`[${accountId}] OMEMO decryption error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    // Fallback to plain body if not encrypted or decryption failed
    if (!body) {
      body = stanza.getChildText("body");
    }
    
    log?.debug?.(`[${accountId}] XMPP message stanza: body=${body ? `"${body.slice(0, 50)}"` : "null"} encrypted=${wasEncrypted}`);
    
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
      wasEncrypted,
      // For MUC, we need the actual sender JID for OMEMO encryption
      // This is extracted from the stanza's 'from' attribute before we modified senderJid
      senderJidForOmemo: bareJid(from),
    };

    await handleInboundMessage(message, cfg, accountId, config, log, setStatus);
  });
}
