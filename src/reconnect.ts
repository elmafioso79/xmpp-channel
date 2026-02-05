/**
 * XMPP Reconnection with Exponential Backoff
 * 
 * Handles automatic reconnection when connection is lost
 */

import type { GatewayStartContext, Logger } from "./types.js";
import {
  activeClients,
  reconnectStates,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
} from "./state.js";

// Forward declaration - will be imported from monitor.ts
// This avoids circular dependency by using dynamic import
type StartXmppConnectionFn = (ctx: GatewayStartContext) => Promise<void>;

let startXmppConnectionFn: StartXmppConnectionFn | null = null;

/**
 * Register the startXmppConnection function to avoid circular import
 */
export function registerStartXmppConnection(fn: StartXmppConnectionFn): void {
  startXmppConnectionFn = fn;
}

/**
 * Initialize reconnect state for an account
 */
export function initReconnectState(accountId: string): void {
  reconnectStates.set(accountId, {
    attempts: 0,
    lastAttemptAt: 0,
    nextDelayMs: RECONNECT_BASE_DELAY_MS,
    aborted: false,
  });
}

/**
 * Clear reconnect state (on successful connection)
 */
export function clearReconnectState(accountId: string): void {
  reconnectStates.delete(accountId);
}

/**
 * Abort reconnection attempts for an account
 */
export function abortReconnect(accountId: string): void {
  const state = reconnectStates.get(accountId);
  if (state) {
    state.aborted = true;
  }
}

/**
 * Schedule a reconnection attempt with exponential backoff
 */
export function scheduleReconnect(
  accountId: string,
  ctx: GatewayStartContext,
  log?: Logger
): void {
  const state = reconnectStates.get(accountId);
  if (!state || state.aborted) {
    log?.debug?.(`[${accountId}] Reconnect aborted or not initialized`);
    return;
  }
  
  if (state.attempts >= RECONNECT_MAX_ATTEMPTS) {
    log?.error?.(`[${accountId}] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached, giving up`);
    ctx.setStatus?.({
      accountId,
      running: false,
      lastError: `Max reconnect attempts reached after ${state.attempts} tries`,
    });
    return;
  }
  
  const delay = Math.min(state.nextDelayMs, RECONNECT_MAX_DELAY_MS);
  state.attempts++;
  state.nextDelayMs = Math.min(state.nextDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  state.lastAttemptAt = Date.now();
  
  log?.info?.(`[${accountId}] Scheduling reconnect in ${delay}ms (attempt ${state.attempts}/${RECONNECT_MAX_ATTEMPTS})`);
  
  ctx.setStatus?.({
    accountId,
    reconnectAttempts: state.attempts,
    reconnectNextAt: Date.now() + delay,
  });
  
  setTimeout(async () => {
    const currentState = reconnectStates.get(accountId);
    if (currentState?.aborted) {
      log?.debug?.(`[${accountId}] Reconnect cancelled (aborted)`);
      return;
    }
    
    log?.info?.(`[${accountId}] Attempting reconnect (attempt ${state.attempts})...`);
    
    try {
      // Remove old client
      activeClients.delete(accountId);
      
      // Start a fresh connection
      if (startXmppConnectionFn) {
        await startXmppConnectionFn(ctx);
      } else {
        log?.error?.(`[${accountId}] startXmppConnection not registered for reconnect`);
      }
    } catch (err) {
      log?.error?.(`[${accountId}] Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      // Will trigger another reconnect via offline event
    }
  }, delay);
}
