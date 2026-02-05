/**
 * Global state management for XMPP connections
 * 
 * These Maps track per-account state. cleanupAccountState() must be called
 * when an account is removed to prevent memory leaks.
 */

import type { client } from "@xmpp/client";
import type { Logger } from "./types.js";

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface ReconnectState {
  attempts: number;
  lastAttemptAt: number;
  nextDelayMs: number;
  aborted: boolean;
}

export interface PendingMucJoin {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

// =============================================================================
// CONSTANTS
// =============================================================================

// XEP-0199 ping interval (30 seconds)
export const KEEPALIVE_INTERVAL_MS = 30000;

// Reconnect configuration
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 60000;
export const RECONNECT_MAX_ATTEMPTS = 20;

// MUC join timing
export const MUC_JOIN_TIMEOUT_MS = 10000;
export const MUC_LEAVE_WAIT_MS = 1000;

// Common MUC domain patterns for detection
export const MUC_DOMAIN_PATTERNS = ["conference.", "muc.", "rooms.", "chat.", "groupchat."];

// =============================================================================
// GLOBAL STATE MAPS
// =============================================================================

// Active XMPP clients by accountId
export const activeClients = new Map<string, ReturnType<typeof client>>();

// Track rooms that returned "gone" error to avoid retry loops
export const goneRooms = new Set<string>();

// Track successfully joined rooms per account (in-memory cache)
export const joinedRooms = new Map<string, Set<string>>();

// Keepalive interval handles for cleanup
export const keepaliveIntervals = new Map<string, NodeJS.Timeout>();

// Reconnect state per account
export const reconnectStates = new Map<string, ReconnectState>();

// Pending MUC join callbacks - keyed by "accountId:roomJid"
// Called when self-presence is received (status code 110)
export const pendingMucJoins = new Map<string, PendingMucJoin>();

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Cleanup all state for an account (call when account is removed from config)
 */
export function cleanupAccountState(accountId: string, log?: Logger): void {
  log?.debug?.(`[${accountId}] Cleaning up account state...`);
  
  // Stop and remove client
  const xmpp = activeClients.get(accountId);
  if (xmpp) {
    try {
      xmpp.stop();
    } catch {
      // Ignore stop errors during cleanup
    }
    activeClients.delete(accountId);
  }
  
  // Clear joined rooms
  joinedRooms.delete(accountId);
  
  // Clear pending MUC joins for this account
  for (const [key, pending] of pendingMucJoins.entries()) {
    if (key.startsWith(`${accountId}:`)) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Account cleanup"));
      pendingMucJoins.delete(key);
    }
  }
  
  // Stop keepalive
  const interval = keepaliveIntervals.get(accountId);
  if (interval) {
    clearInterval(interval);
    keepaliveIntervals.delete(accountId);
  }
  
  // Abort and clear reconnect state
  const reconnectState = reconnectStates.get(accountId);
  if (reconnectState) {
    reconnectState.aborted = true;
  }
  reconnectStates.delete(accountId);
  
  log?.debug?.(`[${accountId}] Account state cleaned up`);
}
