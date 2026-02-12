/**
 * MUC (Multi-User Chat) room management
 * 
 * Handles room persistence, join/leave operations, and "gone" room tracking
 */

import { xml } from "@xmpp/client";
import type { client } from "@xmpp/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bareJid } from "./config-schema.js";
import type { Logger } from "./types.js";
import {
  goneRooms,
  joinedRooms,
  pendingMucJoins,
  MUC_JOIN_TIMEOUT_MS,
  MUC_LEAVE_WAIT_MS,
  MUC_DOMAIN_PATTERNS,
} from "./state.js";

// =============================================================================
// ROOM PERSISTENCE
// =============================================================================

const ROOMS_STORE_FILENAME = "xmpp-rooms.json";

interface RoomsStore {
  rooms: Record<string, string[]>; // accountId -> room JIDs
}

function getRoomsStorePath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".openclaw", "extensions", "xmpp", ROOMS_STORE_FILENAME);
}

function loadPersistedRooms(log?: Logger): RoomsStore {
  try {
    const storePath = getRoomsStorePath();
    if (fs.existsSync(storePath)) {
      const data = fs.readFileSync(storePath, "utf-8");
      return JSON.parse(data) as RoomsStore;
    }
  } catch (err) {
    log?.warn?.(`[XMPP] Failed to load persisted rooms: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { rooms: {} };
}

function savePersistedRooms(store: RoomsStore, log?: Logger): void {
  try {
    const storePath = getRoomsStorePath();
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
    log?.debug?.(`[XMPP] Saved persisted rooms`);
  } catch (err) {
    log?.error?.(`[XMPP] Failed to save persisted rooms: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function addPersistedRoom(accountId: string, roomJid: string, log?: Logger): void {
  const store = loadPersistedRooms(log);
  if (!store.rooms[accountId]) {
    store.rooms[accountId] = [];
  }
  if (!store.rooms[accountId].includes(roomJid)) {
    store.rooms[accountId].push(roomJid);
    savePersistedRooms(store, log);
    log?.info?.(`[XMPP] Persisted room ${roomJid} for account ${accountId}`);
  }
}

export function removePersistedRoom(accountId: string, roomJid: string, log?: Logger): void {
  const store = loadPersistedRooms(log);
  if (store.rooms[accountId]) {
    const idx = store.rooms[accountId].indexOf(roomJid);
    if (idx !== -1) {
      store.rooms[accountId].splice(idx, 1);
      savePersistedRooms(store, log);
      log?.info?.(`[XMPP] Removed persisted room ${roomJid} for account ${accountId}`);
    }
  }
}

export function getPersistedRooms(accountId: string, log?: Logger): string[] {
  const store = loadPersistedRooms(log);
  return store.rooms[accountId] || [];
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if a JID looks like a MUC room based on domain patterns
 */
export function looksLikeMucJid(jid: string): boolean {
  const domain = bareJid(jid).split("@")[1];
  if (!domain) return false;
  return MUC_DOMAIN_PATTERNS.some((pattern) => domain.startsWith(pattern));
}

// =============================================================================
// MUC JOIN/LEAVE
// =============================================================================

/**
 * Join a MUC room with force rejoin to clear ghost participant state
 */
export async function joinMuc(
  xmpp: ReturnType<typeof client>,
  roomJid: string,
  nick: string,
  log?: Logger,
  accountId?: string,
  forceRejoin = true
): Promise<void> {
  // Skip rooms that have returned "gone" error
  if (goneRooms.has(roomJid)) {
    log?.debug?.(`[XMPP] Skipping gone room: ${roomJid}`);
    return;
  }

  const fullJid = `${roomJid}/${nick}`;
  
  // Force rejoin: send unavailable presence first to clear any ghost state
  if (forceRejoin) {
    log?.debug?.(`[XMPP] Force leave before join: ${roomJid}`);
    try {
      const leavePresence = xml("presence", { to: fullJid, type: "unavailable" });
      await xmpp.send(leavePresence);
      // Wait for server to process the leave
      await new Promise((r) => setTimeout(r, MUC_LEAVE_WAIT_MS));
    } catch (err) {
      // Ignore errors on leave - room may not have had us joined
      log?.debug?.(`[XMPP] Leave presence ignored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log?.debug?.(`[XMPP] Joining MUC: ${roomJid}`);

  const presence = xml(
    "presence",
    { to: fullJid },
    xml("x", { xmlns: "http://jabber.org/protocol/muc" })
  );

  try {
    // Create promise to wait for self-presence (status code 110) if we have accountId
    let joinConfirmation: Promise<void> | undefined;
    if (accountId) {
      const pendingKey = `${accountId}:${roomJid}`;
      joinConfirmation = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingMucJoins.delete(pendingKey);
          // Don't reject for config rooms - just log and continue
          log?.warn?.(`[XMPP] MUC join confirmation timeout for ${roomJid}, proceeding anyway`);
          resolve();
        }, MUC_JOIN_TIMEOUT_MS);
        
        pendingMucJoins.set(pendingKey, { resolve, reject, timeout });
      });
    }
    
    await xmpp.send(presence);
    log?.debug?.(`[XMPP] Sent join presence to ${roomJid}, waiting for confirmation...`);
    
    // Wait for self-presence confirmation
    if (joinConfirmation) {
      await joinConfirmation;
    }
    
    // Track as joined
    if (accountId) {
      if (!joinedRooms.has(accountId)) {
        joinedRooms.set(accountId, new Set());
      }
      joinedRooms.get(accountId)!.add(roomJid);
    }
    log?.info?.(`[XMPP] Joined MUC: ${roomJid}`);
  } catch (err) {
    log?.error?.(`[XMPP] Failed to join MUC ${roomJid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Handle MUC invite - join the room and send acknowledgments
 */
export async function handleMucInvite(
  xmpp: ReturnType<typeof client>,
  roomJid: string,
  inviterJid: string,
  nickname: string,
  accountId: string,
  log?: Logger
): Promise<void> {
  // If we receive an invite, the room exists - clear any "gone" status
  if (goneRooms.has(roomJid)) {
    log?.info?.(`[${accountId}] Room ${roomJid} was recreated, clearing gone status`);
    goneRooms.delete(roomJid);
  }
  
  log?.debug?.(`[${accountId}] Auto-joining ${roomJid} as ${nickname}`);
  
  try {
    // Send presence to join the room and wait for self-presence confirmation
    const joinPresence = xml(
      "presence",
      { to: `${roomJid}/${nickname}` },
      xml("x", { xmlns: "http://jabber.org/protocol/muc" })
    );
    
    // Create promise to wait for self-presence (status code 110)
    const pendingKey = `${accountId}:${roomJid}`;
    const joinConfirmation = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingMucJoins.delete(pendingKey);
        reject(new Error(`MUC join timeout after ${MUC_JOIN_TIMEOUT_MS}ms`));
      }, MUC_JOIN_TIMEOUT_MS);
      
      pendingMucJoins.set(pendingKey, { resolve, reject, timeout });
    });
    
    await xmpp.send(joinPresence);
    log?.debug?.(`[${accountId}] Sent join presence to ${roomJid}, waiting for self-presence...`);
    
    // Wait for self-presence confirmation (or timeout)
    await joinConfirmation;
    log?.info?.(`[${accountId}] MUC join confirmed for ${roomJid}`);
    
    // Track as joined (in-memory)
    if (!joinedRooms.has(accountId)) {
      joinedRooms.set(accountId, new Set());
    }
    joinedRooms.get(accountId)!.add(roomJid);
    
    // Persist the room so we rejoin after restart
    addPersistedRoom(accountId, roomJid, log);
    
    // Send acknowledgment message to inviter via DM
    if (inviterJid) {
      const ackMsg = xml(
        "message",
        { to: inviterJid, type: "chat" },
        xml("body", {}, `Joined ${roomJid} — thanks for the invite!`)
      );
      await xmpp.send(ackMsg);
      log?.debug?.(`[${accountId}] Sent ack to ${inviterJid}`);
    }
    
    // Send greeting to the room (we've confirmed join via self-presence)
    const greeting = xml(
      "message",
      { to: roomJid, type: "groupchat" },
      xml("body", {}, `[${nickname}] has joined — thanks for the invite, ${inviterJid.split("@")[0]}!`)
    );
    await xmpp.send(greeting);
    log?.debug?.(`[${accountId}] Sent greeting to room ${roomJid}`);
  } catch (err) {
    log?.error?.(`[${accountId}] Failed to join room ${roomJid}: ${err instanceof Error ? err.message : String(err)}`);
    
    // Notify inviter of failure
    if (inviterJid) {
      const failMsg = xml(
        "message",
        { to: inviterJid, type: "chat" },
        xml("body", {}, `Sorry, I couldn't join ${roomJid}: ${err instanceof Error ? err.message : "unknown error"}`)
      );
      await xmpp.send(failMsg).catch((sendErr) => {
        log?.debug?.(`[${accountId}] Failed to notify inviter of join failure: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
      });
    }
  }
}
