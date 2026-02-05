/**
 * XEP-0199 XMPP Ping (Keepalive)
 * 
 * Sends periodic ping IQ stanzas to keep the connection alive
 */

import { xml } from "@xmpp/client";
import type { client } from "@xmpp/client";
import type { Logger } from "./types.js";
import { keepaliveIntervals, KEEPALIVE_INTERVAL_MS } from "./state.js";

/**
 * Start XEP-0199 keepalive pings
 */
export function startKeepalive(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  server: string,
  log?: Logger
): void {
  // Clear any existing interval
  const existing = keepaliveIntervals.get(accountId);
  if (existing) {
    clearInterval(existing);
  }

  const interval = setInterval(async () => {
    try {
      // XEP-0199: Send IQ ping to server
      const pingId = `ping-${Date.now()}`;
      const ping = xml(
        "iq",
        { type: "get", to: server, id: pingId },
        xml("ping", { xmlns: "urn:xmpp:ping" })
      );
      
      await xmpp.send(ping);
      log?.debug?.(`[${accountId}] XEP-0199 keepalive ping sent`);
    } catch (err) {
      log?.warn?.(`[${accountId}] Keepalive ping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, KEEPALIVE_INTERVAL_MS);

  keepaliveIntervals.set(accountId, interval);
  log?.debug?.(`[${accountId}] XEP-0199 keepalive started (${KEEPALIVE_INTERVAL_MS / 1000}s interval)`);
}

/**
 * Stop keepalive pings
 */
export function stopKeepalive(accountId: string): void {
  const interval = keepaliveIntervals.get(accountId);
  if (interval) {
    clearInterval(interval);
    keepaliveIntervals.delete(accountId);
  }
}
