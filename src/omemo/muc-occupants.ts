/**
 * MUC Occupant Tracker for OMEMO
 * 
 * Tracks room occupants and their real JIDs for MUC OMEMO encryption.
 * In non-anonymous MUC rooms, the server provides real JIDs in presence stanzas.
 * 
 * XEP-0045: Multi-User Chat
 * XEP-0384: OMEMO Encryption (MUC support)
 */

import type { Element } from "@xmpp/client";
import { bareJid } from "../config-schema.js";
import type { Logger } from "../types.js";

// =============================================================================
// TYPES
// =============================================================================

/**
 * A room occupant with optional real JID
 */
export interface MucOccupant {
  /** Occupant nick (resource part of occupant JID) */
  nick: string;
  /** Full occupant JID (room@conference/nick) */
  occupantJid: string;
  /** Real bare JID if available (non-anonymous rooms) */
  realJid?: string;
  /** MUC affiliation (owner, admin, member, none, outcast) */
  affiliation?: string;
  /** MUC role (moderator, participant, visitor, none) */
  role?: string;
}

/**
 * Room anonymity level
 */
export type RoomAnonymity = "non-anonymous" | "semi-anonymous" | "unknown";

/**
 * Room state
 */
interface RoomState {
  /** Room JID */
  roomJid: string;
  /** Anonymity level */
  anonymity: RoomAnonymity;
  /** Occupants by nick */
  occupants: Map<string, MucOccupant>;
  /** Our own nick in this room */
  selfNick?: string;
  /** Timestamp of last update */
  lastUpdated: number;
}

// =============================================================================
// STATE
// =============================================================================

/** Room states by "accountId:roomJid" */
const roomStates = new Map<string, RoomState>();

// =============================================================================
// KEY HELPERS
// =============================================================================

function roomKey(accountId: string, roomJid: string): string {
  return `${accountId}:${bareJid(roomJid)}`;
}

// =============================================================================
// ROOM STATE MANAGEMENT
// =============================================================================

/**
 * Get or create room state
 */
function getOrCreateRoom(accountId: string, roomJid: string): RoomState {
  const key = roomKey(accountId, roomJid);
  let state = roomStates.get(key);
  if (!state) {
    state = {
      roomJid: bareJid(roomJid),
      anonymity: "unknown",
      occupants: new Map(),
      lastUpdated: Date.now(),
    };
    roomStates.set(key, state);
  }
  return state;
}

/**
 * Get room state if it exists
 */
export function getRoomState(accountId: string, roomJid: string): RoomState | undefined {
  return roomStates.get(roomKey(accountId, roomJid));
}

/**
 * Clear room state (on leave or disconnect)
 */
export function clearRoomState(accountId: string, roomJid: string): void {
  roomStates.delete(roomKey(accountId, roomJid));
}

/**
 * Clear all room states for an account
 */
export function clearAllRoomStates(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const key of roomStates.keys()) {
    if (key.startsWith(prefix)) {
      roomStates.delete(key);
    }
  }
}

// =============================================================================
// PRESENCE HANDLING
// =============================================================================

/**
 * Parse MUC presence stanza and update occupant tracking.
 * 
 * XEP-0045 presence contains:
 * - <x xmlns="http://jabber.org/protocol/muc#user">
 *   - <item affiliation="member" role="participant" jid="real@jid/resource"/>
 *   - <status code="..."/>
 * 
 * Status codes:
 * - 100: Room is non-anonymous (real JIDs visible to all)
 * - 110: Self-presence (this is us)
 * - 172: Room is non-anonymous
 * - 303: Occupant nick changed
 * 
 * @param stanza - Presence stanza
 * @param accountId - Our account ID  
 * @param log - Logger
 * @returns Whether the presence was handled as MUC presence
 */
export function handleMucPresence(
  stanza: Element,
  accountId: string,
  log?: Logger
): boolean {
  if (!stanza.is("presence")) return false;
  
  const from = stanza.attrs.from as string | undefined;
  if (!from) return false;
  
  // Parse occupant JID: room@conference/nick
  const slashIdx = from.indexOf("/");
  if (slashIdx === -1) return false; // Not an occupant JID
  
  const roomJid = from.substring(0, slashIdx);
  const nick = from.substring(slashIdx + 1);
  
  // Check for MUC user extension
  const mucUserX = stanza.getChild("x", "http://jabber.org/protocol/muc#user");
  if (!mucUserX) return false;
  
  const presenceType = stanza.attrs.type as string | undefined;
  const room = getOrCreateRoom(accountId, roomJid);
  
  // Parse status codes
  const statusCodes = new Set<string>();
  for (const status of mucUserX.getChildren("status")) {
    if (status.attrs.code) {
      statusCodes.add(status.attrs.code);
    }
  }
  
  // Check if room is non-anonymous
  if (statusCodes.has("100") || statusCodes.has("172")) {
    room.anonymity = "non-anonymous";
    log?.debug?.(`[${accountId}] Room ${roomJid} is non-anonymous (OMEMO-capable)`);
  }
  
  // Check if this is self-presence
  if (statusCodes.has("110")) {
    room.selfNick = nick;
    log?.debug?.(`[${accountId}] Self-presence in ${roomJid} as ${nick}`);
  }
  
  // Handle leave (unavailable presence)
  if (presenceType === "unavailable") {
    room.occupants.delete(nick);
    room.lastUpdated = Date.now();
    log?.debug?.(`[${accountId}] Occupant left ${roomJid}: ${nick}`);
    return true;
  }
  
  // Parse item element for occupant details
  const item = mucUserX.getChild("item");
  if (!item) return true; // Valid MUC presence but no item details
  
  const occupant: MucOccupant = {
    nick,
    occupantJid: from,
    affiliation: item.attrs.affiliation,
    role: item.attrs.role,
  };
  
  // Extract real JID if provided (non-anonymous rooms)
  const realJidAttr = item.attrs.jid as string | undefined;
  if (realJidAttr) {
    occupant.realJid = bareJid(realJidAttr);
    log?.debug?.(`[${accountId}] Occupant ${nick} in ${roomJid}: realJid=${occupant.realJid}`);
  }
  
  room.occupants.set(nick, occupant);
  room.lastUpdated = Date.now();
  
  return true;
}

// =============================================================================
// OMEMO HELPERS
// =============================================================================

/**
 * Get all real JIDs of room occupants for OMEMO encryption.
 * 
 * Only returns JIDs if:
 * - Room is non-anonymous (real JIDs are available)
 * - Room has at least one occupant with a real JID
 * 
 * @param accountId - Our account ID
 * @param roomJid - Room JID
 * @param excludeSelf - Whether to exclude our own JID
 * @returns Array of real bare JIDs, or null if not available
 */
export function getRoomOccupantJids(
  accountId: string,
  roomJid: string,
  excludeSelf: boolean = true
): string[] | null {
  const room = roomStates.get(roomKey(accountId, roomJid));
  if (!room) {
    return null;
  }
  
  // Only support non-anonymous rooms for OMEMO
  if (room.anonymity !== "non-anonymous") {
    return null;
  }
  
  const jids: string[] = [];
  for (const occupant of room.occupants.values()) {
    if (!occupant.realJid) continue;
    
    // Optionally exclude self
    if (excludeSelf && occupant.nick === room.selfNick) continue;
    
    // Avoid duplicates (same user with multiple resources)
    if (!jids.includes(occupant.realJid)) {
      jids.push(occupant.realJid);
    }
  }
  
  return jids.length > 0 ? jids : null;
}

/**
 * Check if a room supports OMEMO (non-anonymous with tracked occupants)
 */
export function isRoomOmemoCapable(accountId: string, roomJid: string): boolean {
  const room = roomStates.get(roomKey(accountId, roomJid));
  if (!room) return false;
  return room.anonymity === "non-anonymous" && room.occupants.size > 0;
}

/**
 * Get room anonymity level
 */
export function getRoomAnonymity(accountId: string, roomJid: string): RoomAnonymity {
  const room = roomStates.get(roomKey(accountId, roomJid));
  return room?.anonymity ?? "unknown";
}

/**
 * Get occupant count for a room
 */
export function getRoomOccupantCount(accountId: string, roomJid: string): number {
  const room = roomStates.get(roomKey(accountId, roomJid));
  return room?.occupants.size ?? 0;
}

/**
 * Get an occupant's real JID by their nick.
 * 
 * Used for MUC OMEMO decryption to map occupant nick to real JID.
 * 
 * @param accountId - Our account ID
 * @param roomJid - Room JID
 * @param nick - Occupant nick (resource part of room@conference/nick)
 * @returns Real bare JID or null if not found/unavailable
 */
export function getOccupantRealJid(
  accountId: string,
  roomJid: string,
  nick: string
): string | null {
  const room = roomStates.get(roomKey(accountId, roomJid));
  if (!room) return null;
  
  const occupant = room.occupants.get(nick);
  if (!occupant) return null;
  
  return occupant.realJid ?? null;
}

// =============================================================================
// STATISTICS
// =============================================================================

/**
 * Get occupant tracking statistics
 */
export function getOccupantStats(): {
  rooms: number;
  occupants: number;
  withRealJids: number;
  omemoCapable: number;
} {
  let occupants = 0;
  let withRealJids = 0;
  let omemoCapable = 0;
  
  for (const room of roomStates.values()) {
    occupants += room.occupants.size;
    for (const occ of room.occupants.values()) {
      if (occ.realJid) withRealJids++;
    }
    if (room.anonymity === "non-anonymous") omemoCapable++;
  }
  
  return {
    rooms: roomStates.size,
    occupants,
    withRealJids,
    omemoCapable,
  };
}
