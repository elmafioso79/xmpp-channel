/**
 * OMEMO Device List Cache (XEP-0384)
 * 
 * Caches device lists fetched from PEP to avoid repeated queries.
 * Listens to PEP events to maintain cache freshness.
 */

import type { Logger } from "../types.js";
import { fetchDeviceList, parseDeviceListEvent } from "./device.js";
import { NS_OMEMO_DEVICES } from "./types.js";
import type { OmemoDevice } from "./types.js";
import type { PepItem } from "../pep.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum cache age before forcing refresh (15 minutes) */
const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

// =============================================================================
// CACHE STATE
// =============================================================================

interface CacheEntry {
  devices: OmemoDevice[];
  timestamp: number;
}

/** Device list cache by JID (accountId:jid -> devices) */
const deviceCache = new Map<string, CacheEntry>();

// =============================================================================
// CACHE KEY HELPERS
// =============================================================================

/**
 * Generate cache key from account ID and JID
 */
function cacheKey(accountId: string, jid: string): string {
  const bareJid = jid.split("/")[0]; // Normalize to bare JID
  return `${accountId}:${bareJid}`;
}

// =============================================================================
// CACHE OPERATIONS
// =============================================================================

/**
 * Get cached device list for a JID
 * 
 * @param accountId - Our account ID
 * @param jid - Target JID (empty string = self)
 * @returns Cached devices or undefined if not cached or expired
 */
export function getCachedDevices(
  accountId: string,
  jid: string
): OmemoDevice[] | undefined {
  const key = cacheKey(accountId, jid);
  const entry = deviceCache.get(key);
  
  if (!entry) {
    return undefined;
  }
  
  // Check if cache is expired
  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL_MS) {
    return undefined;
  }
  
  return entry.devices;
}

/**
 * Set cached device list for a JID
 */
export function setCachedDevices(
  accountId: string,
  jid: string,
  devices: OmemoDevice[]
): void {
  const key = cacheKey(accountId, jid);
  deviceCache.set(key, {
    devices,
    timestamp: Date.now(),
  });
}

/**
 * Invalidate cache for a JID
 */
export function invalidateCachedDevices(accountId: string, jid: string): void {
  const key = cacheKey(accountId, jid);
  deviceCache.delete(key);
}

/**
 * Clear all cached device lists for an account
 */
export function clearDeviceCache(accountId: string): void {
  for (const key of deviceCache.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      deviceCache.delete(key);
    }
  }
}

/**
 * Clear entire device cache
 */
export function clearAllDeviceCache(): void {
  deviceCache.clear();
}

// =============================================================================
// FETCHING WITH CACHE
// =============================================================================

/**
 * Get device list for a JID, using cache if available
 * 
 * @param accountId - Our account ID
 * @param jid - Target JID (empty string = self)
 * @param forceRefresh - Force fetching from server even if cached
 * @param log - Logger
 * @returns Device list
 */
export async function getDeviceList(
  accountId: string,
  jid: string,
  forceRefresh: boolean = false,
  log?: Logger
): Promise<OmemoDevice[]> {
  // Check cache first (unless forcing refresh)
  if (!forceRefresh) {
    const cached = getCachedDevices(accountId, jid);
    if (cached) {
      log?.debug?.(`[${accountId}] OMEMO device cache hit for ${jid || "self"}: ${cached.length} devices`);
      return cached;
    }
  }
  
  // Fetch from server
  log?.debug?.(`[${accountId}] OMEMO fetching device list for ${jid || "self"}`);
  const devices = await fetchDeviceList(accountId, jid, log);
  
  // Update cache
  setCachedDevices(accountId, jid, devices);
  log?.debug?.(`[${accountId}] OMEMO cached ${devices.length} devices for ${jid || "self"}`);
  
  return devices;
}

// =============================================================================
// PEP EVENT HANDLING
// =============================================================================

/**
 * Handle device list PEP event
 * 
 * Updates cache when device lists change via PEP notifications.
 * Register this with registerPepEventHandler().
 */
export async function handleDeviceListPepEvent(event: {
  accountId: string;
  from: string;
  node: string;
  items: PepItem[];
  retracted: string[];
  log?: Logger;
}): Promise<void> {
  const { accountId, from, node, items, log } = event;
  
  // Only handle device list node
  if (node !== NS_OMEMO_DEVICES) {
    return;
  }
  
  log?.debug?.(`[${accountId}] OMEMO device list PEP event from ${from}`);
  
  // Parse device list from the items
  for (const item of items) {
    const devices = parseDeviceListEvent(item.payload);
    if (devices.length > 0) {
      // Update cache
      const bareFrom = from.split("/")[0];
      setCachedDevices(accountId, bareFrom, devices);
      log?.info?.(`[${accountId}] OMEMO device list updated for ${bareFrom}: ${devices.map(d => d.id).join(", ")}`);
    }
  }
}

// =============================================================================
// STATISTICS
// =============================================================================

/**
 * Get cache statistics
 */
export function getDeviceCacheStats(): {
  entries: number;
  totalDevices: number;
} {
  let totalDevices = 0;
  for (const entry of deviceCache.values()) {
    totalDevices += entry.devices.length;
  }
  return {
    entries: deviceCache.size,
    totalDevices,
  };
}
