import { client, xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import type { XmppConfig, GatewayStartContext, XmppInboundMessage, Logger } from "./types.js";
import { resolveServer, extractUsername, bareJid } from "./config-schema.js";
import { getXmppRuntime } from "./runtime.js";
import { normalizeAllowFrom, isSenderAllowed } from "./normalize.js";
import { parsePepEvent, type PepItem } from "./pep.js";
import { sendXmppMedia } from "./outbound.js";

// PEP event handlers registry
type PepEventHandler = (event: {
  accountId: string;
  from: string;
  node: string;
  items: PepItem[];
  retracted: string[];
  log?: Logger;
}) => void | Promise<void>;

const pepEventHandlers: PepEventHandler[] = [];

// Active XMPP clients by accountId
const activeClients = new Map<string, ReturnType<typeof client>>();

/**
 * Start XMPP connection for an account
 * Returns a promise that stays pending until the connection is stopped
 */
export async function startXmppConnection(ctx: GatewayStartContext): Promise<void> {
  const { account, cfg, abortSignal, log, setStatus } = ctx;
  // Use ctx.accountId if available, otherwise fall back to account.accountId
  const accountId = ctx.accountId ?? account.accountId ?? "default";
  const config = account.config;

  // Debug: log context properties
  log?.debug?.(`[${accountId}] Gateway context: hasSetStatus=${!!setStatus}`);

  if (!config.jid || !config.password) {
    throw new Error("XMPP jid and password are required");
  }

  const server = resolveServer(config);
  const username = extractUsername(config.jid);
  const resource = config.resource ?? "openclaw";

  log?.info?.(`[${accountId}] Starting XMPP connection to ${server}...`);

  // Mark as starting - use setStatus if available
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
    resource,
  });

  // Store client for outbound messaging
  activeClients.set(accountId, xmpp);

  // Handle incoming stanzas (messages)
  xmpp.on("stanza", async (stanza) => {
    log?.debug?.(`[${accountId}] XMPP stanza received: attrs=${JSON.stringify(stanza.attrs)}`);
    
    if (!stanza.is("message")) return;

    // Check for PEP events first (message with event element)
    const pepEvent = parsePepEvent(stanza as Element);
    if (pepEvent) {
      log?.debug?.(`[${accountId}] PEP event from ${pepEvent.from}: node=${pepEvent.node}, items=${pepEvent.items.length}`);
      // Dispatch to registered PEP handlers
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
      return; // PEP events don't have a body to process as chat
    }

    const body = stanza.getChildText("body");
    log?.debug?.(`[${accountId}] XMPP message stanza: body=${body ? `"${body.slice(0, 50)}"` : "null"}`);
    
    if (!body) return; // Skip messages without body (e.g., typing indicators)

    // Skip history messages (MUC sends old messages with delay element on join)
    const delay = stanza.getChild("delay", "urn:xmpp:delay") || stanza.getChild("x", "jabber:x:delay");
    if (delay) {
      log?.debug?.(`[${accountId}] XMPP skipping history message (has delay element)`);
      return;
    }

    const from = stanza.attrs.from;
    const to = stanza.attrs.to;
    const type = stanza.attrs.type || "chat";
    const id = stanza.attrs.id || `msg_${Date.now()}`;

    // Parse MUC vs direct message
    const isGroup = type === "groupchat";
    let senderJid = from;
    let roomJid: string | undefined;
    let senderNick: string | undefined;

    if (isGroup) {
      // In MUC, from is "room@conference/nick"
      roomJid = bareJid(from);
      senderNick = from.split("/")[1];
      
      // Skip self-messages in MUC (echoes of our own messages)
      if (senderNick === resource) {
        log?.debug?.(`[${accountId}] XMPP skipping self-message in MUC (nick=${senderNick})`);
        return;
      }
    }

    // Log the inbound message AFTER filtering
    log?.info?.(`[${accountId}] XMPP inbound message: from=${from} type=${type}`);

    const message: XmppInboundMessage = {
      id,
      from: senderJid,
      to,
      body,
      type: type as XmppInboundMessage["type"],
      timestamp: Date.now(),
      isGroup,
      roomJid,
      senderNick,
    };

    await handleInboundMessage(message, cfg, accountId, config, log);
  });

  // Handle presence stanzas (subscription requests, probes)
  xmpp.on("stanza", async (stanza) => {
    if (!stanza.is("presence")) return;
    
    const type = stanza.attrs.type;
    const from = stanza.attrs.from;
    
    if (!from) return;
    
    const fromBare = bareJid(from);
    
    // Handle subscription requests - auto-approve
    if (type === "subscribe") {
      log?.info?.(`[${accountId}] XMPP presence subscribe from ${fromBare} - auto-approving`);
      
      // Send subscribed (approve their request)
      const subscribed = xml("presence", { to: fromBare, type: "subscribed" });
      await xmpp.send(subscribed);
      
      // Also subscribe back to them (mutual subscription)
      const subscribe = xml("presence", { to: fromBare, type: "subscribe" });
      await xmpp.send(subscribe);
      
      log?.debug?.(`[${accountId}] XMPP sent subscribed + subscribe to ${fromBare}`);
    }
    
    // Handle probe - respond with current presence
    if (type === "probe") {
      log?.debug?.(`[${accountId}] XMPP presence probe from ${fromBare} - responding`);
      const presence = xml("presence", { to: fromBare });
      await xmpp.send(presence);
    }
    
    // Handle unsubscribe - acknowledge it
    if (type === "unsubscribe") {
      log?.info?.(`[${accountId}] XMPP presence unsubscribe from ${fromBare}`);
      const unsubscribed = xml("presence", { to: fromBare, type: "unsubscribed" });
      await xmpp.send(unsubscribed);
    }
  });

  // Connection events
  xmpp.on("online", (address) => {
    log?.info?.(`[${accountId}] XMPP online as ${address.toString()}`);
    
    // Send initial presence to indicate we're online and available
    const initialPresence = xml("presence", {}, 
      xml("status", {}, "OpenClaw Bot Online"),
      xml("priority", {}, "1")
    );
    xmpp.send(initialPresence).then(() => {
      log?.debug?.(`[${accountId}] XMPP initial presence sent`);
    }).catch((err) => {
      log?.error?.(`[${accountId}] XMPP failed to send initial presence: ${err.message}`);
    });
    
    // Mark as connected
    setStatus?.({
      accountId,
      running: true,
      connected: true,
      lastConnectedAt: Date.now(),
      lastError: null,
    });

    // Join MUC rooms if configured
    if (config.mucs && config.mucs.length > 0) {
      for (const muc of config.mucs) {
        joinMuc(xmpp, muc, resource, log);
      }
    }
  });

  xmpp.on("offline", () => {
    log?.info?.(`[${accountId}] XMPP offline`);
    
    // Mark as disconnected
    setStatus?.({
      accountId,
      running: false,
      connected: false,
      lastDisconnect: Date.now(),
    });
  });

  xmpp.on("error", (err) => {
    log?.error?.(`[${accountId}] XMPP error: ${err.message}`);
    
    // Record the error
    setStatus?.({
      accountId,
      lastError: err.message,
    });
  });

  // Start connection
  await xmpp.start();

  // Return a promise that stays pending until the connection is stopped
  // This keeps the gateway task alive - if we return immediately, 
  // OpenClaw's channel manager will think the channel has stopped
  return new Promise<void>((resolve) => {
    let stopped = false;
    
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      log?.info?.(`[${accountId}] Stopping XMPP connection...`);
      xmpp.stop();
      activeClients.delete(accountId);
      
      // Mark as stopped
      setStatus?.({
        accountId,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
      
      resolve();
    };

    // Handle abort signal for graceful shutdown
    abortSignal?.addEventListener("abort", cleanup);
    
    // Also handle xmpp offline event to resolve the promise
    xmpp.on("offline", () => {
      if (!stopped) {
        cleanup();
      }
    });
  });
}

/**
 * Join a MUC room
 */
function joinMuc(
  xmpp: ReturnType<typeof client>,
  roomJid: string,
  nick: string,
  log?: Logger
): void {
  log?.debug?.(`[XMPP] Joining MUC: ${roomJid}`);

  const presence = xml(
    "presence",
    { to: `${roomJid}/${nick}` },
    xml("x", { xmlns: "http://jabber.org/protocol/muc" })
  );

  xmpp.send(presence).catch((err) => {
    log?.error?.(`[XMPP] Failed to join MUC ${roomJid}: ${err.message}`);
  });
}

/**
 * Handle inbound message
 */
async function handleInboundMessage(
  message: XmppInboundMessage,
  cfg: unknown,
  accountId: string,
  config: XmppConfig,
  log?: Logger
): Promise<void> {
  const rt = getXmppRuntime();

  // Check allowlist
  const allowFrom = normalizeAllowFrom(config.allowFrom);
  const senderBare = bareJid(message.from);

  if (!isSenderAllowed(allowFrom, senderBare)) {
    log?.debug?.(`[XMPP] Message blocked: ${senderBare} not in allowlist`);
    return;
  }

  log?.info?.(`[XMPP] Inbound: from=${senderBare} body="${message.body.slice(0, 50)}..."`);

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

  log?.debug?.(`[XMPP] Route: ${route.sessionKey} agent=${route.agentId}`);

  const storePath = rt.channel.session.resolveStorePath((cfg as any).session?.store, {
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
        log?.debug?.(`[XMPP] Deliver: text=${!!payload.text} markdown=${!!payload.markdown} media=${!!(payload.mediaUrl || payload.mediaUrls?.length)}`);
        
        const xmppClient = activeClients.get(accountId);
        if (!xmppClient) {
          log?.error?.("[XMPP] No active client for reply");
          return;
        }

        const replyTo = message.isGroup ? message.roomJid! : senderBare;
        const msgType = message.isGroup ? "groupchat" : "chat";
        const textToSend = payload.markdown || payload.text;
        
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
            }
          }
          return;
        }
        
        // No media, send text only
        if (!textToSend) {
          log?.debug?.("[XMPP] No text or media to send, skipping");
          return;
        }
        
        log?.info?.(`[XMPP] Reply to ${replyTo}: ${textToSend.slice(0, 50)}...`);

        const reply = xml(
          "message",
          { to: replyTo, type: msgType },
          xml("body", {}, textToSend)
        );

        await xmppClient.send(reply);
        log?.debug?.(`[XMPP] Sent to ${replyTo}`);
      },
    },
  });
}

/**
 * Get active client for an account
 */
export function getActiveClient(accountId: string): ReturnType<typeof client> | undefined {
  return activeClients.get(accountId);
}

/**
 * Register a PEP event handler
 * Handlers are called when PEP notifications are received
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
