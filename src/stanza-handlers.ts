/**
 * XMPP Stanza Handlers
 * 
 * Handles presence stanzas (subscriptions, MUC self-presence, errors)
 * and MUC invite messages
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import type { client } from "@xmpp/client";
import { bareJid } from "./config-schema.js";
import type { Logger } from "./types.js";
import { goneRooms, pendingMucJoins } from "./state.js";
import { removePersistedRoom, handleMucInvite } from "./rooms.js";
import { handleMucPresence } from "./omemo/muc-occupants.js";

/**
 * Setup presence stanza handlers on the XMPP client
 */
export function setupPresenceHandlers(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  log?: Logger
): void {
  xmpp.on("stanza", async (stanza) => {
    if (!stanza.is("presence")) return;
    
    const type = stanza.attrs.type;
    const from = stanza.attrs.from;
    
    if (!from) return;
    
    const fromBare = bareJid(from);
    
    // Track MUC occupants for OMEMO encryption
    // This must be called early to track all occupant changes
    handleMucPresence(stanza as Element, accountId, log);
    
    // Check for MUC self-presence (status code 110) - indicates we've joined
    // <presence from="room@conf/mynick"><x xmlns="...muc#user"><status code="110"/></x></presence>
    const mucUserX = stanza.getChild("x", "http://jabber.org/protocol/muc#user");
    if (mucUserX && !type) {
      const statuses = mucUserX.getChildren("status");
      const isSelfPresence = statuses.some((s) => s.attrs.code === "110");
      
      if (isSelfPresence) {
        const pendingKey = `${accountId}:${fromBare}`;
        const pending = pendingMucJoins.get(pendingKey);
        if (pending) {
          log?.debug?.(`[${accountId}] MUC self-presence received for ${fromBare}`);
          clearTimeout(pending.timeout);
          pending.resolve();
          pendingMucJoins.delete(pendingKey);
        }
      }
    }
    
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
    
    // Handle presence errors (e.g., MUC join failures)
    if (type === "error") {
      handlePresenceError(stanza, accountId, from, log);
    }
  });
}

/**
 * Handle presence error stanzas
 */
function handlePresenceError(
  stanza: Element,
  accountId: string,
  from: string,
  log?: Logger
): void {
  const errorEl = stanza.getChild("error");
  const errorType = errorEl?.attrs?.type || "unknown";
  // Get the first child element that isn't "text" as the error condition
  const errorCondition = errorEl?.children
    ?.filter((c): c is Element => typeof c !== "string" && c.name !== "text")
    ?.[0]?.name || "unknown";
  const errorText = errorEl?.getChildText("text") || "";
  
  const roomJid = bareJid(from);
  
  // Handle specific error conditions
  if (errorCondition === "conflict") {
    // Nick conflict should be rare now that we use unique resources per session
    // If it still happens, it's likely a config issue (same nickname on multiple instances)
    log?.error?.(`[${accountId}] MUC nick conflict in ${roomJid} - check if another instance is using the same nickname`);
  } else if (errorCondition === "gone") {
    // Room no longer exists
    goneRooms.add(roomJid);
    removePersistedRoom(accountId, roomJid, log);
    log?.warn?.(`[${accountId}] Room ${roomJid} no longer exists, removed from persisted rooms`);
  } else if (errorCondition === "recipient-unavailable") {
    // Harmless - server couldn't deliver presence (user offline, no subscription, transient state)
    // Silently ignore - doesn't affect message delivery
  } else {
    // Other errors - log as warning (not error, since presence errors are often transient)
    log?.warn?.(`[${accountId}] XMPP presence error from ${from}: type=${errorType} condition=${errorCondition} text="${errorText}"`);
  }
}

/**
 * Setup MUC invite handler on the XMPP client
 */
export function setupMucInviteHandler(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  nickname: string,
  log?: Logger
): void {
  xmpp.on("stanza", async (stanza) => {
    if (!stanza.is("message")) return;
    
    const from = stanza.attrs.from;
    if (!from) return;
    
    // Check for MUC mediated invite: <x xmlns="http://jabber.org/protocol/muc#user"><invite from="...">...
    const mucUserX = stanza.getChild("x", "http://jabber.org/protocol/muc#user");
    if (!mucUserX) return;
    
    const invite = mucUserX.getChild("invite");
    if (!invite) return;
    
    const roomJid = bareJid(from);
    const inviterJid = bareJid(invite.attrs.from || "");
    const reason = invite.getChildText("reason") || "No reason provided";
    
    log?.info?.(`[${accountId}] MUC invite: room=${roomJid} from=${inviterJid} reason="${reason}"`);
    
    await handleMucInvite(xmpp, roomJid, inviterJid, nickname, accountId, log);
  });
}
