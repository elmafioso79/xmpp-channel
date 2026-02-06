/**
 * OMEMO Device Management (XEP-0384)
 * 
 * Handles device ID publication and retrieval via PEP (XEP-0163).
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import { pepPublish, pepFetch } from "../pep.js";
import type { Logger } from "../types.js";
import { NS_OMEMO, NS_OMEMO_DEVICES } from "./types.js";

// =============================================================================
// DEVICE MANAGEMENT
// =============================================================================

/**
 * Publish our device ID to the device list via PEP.
 * 
 * @param replaceAll - If true, replace the entire device list with just our device.
 *                     Use this when starting fresh (no persisted keys) to avoid
 *                     accumulating stale device IDs on the server.
 */
export async function publishDeviceId(
  accountId: string,
  deviceId: number,
  deviceLabel?: string,
  log?: Logger,
  replaceAll: boolean = false
): Promise<{ ok: boolean; error?: string }> {
  try {
    let allDeviceIds: Set<number>;
    
    if (replaceAll) {
      // Fresh start: publish only our device, removing stale ones
      log?.info?.(`[${accountId}] OMEMO replacing device list with only device ${deviceId}`);
      allDeviceIds = new Set([deviceId]);
    } else {
      // Normal: merge with existing device list
      const existingDevices = await fetchOwnDeviceList(accountId, log);
      allDeviceIds = new Set(existingDevices.map(d => d.id));
      allDeviceIds.add(deviceId);
    }

    // Build device elements (legacy OMEMO uses 'list' element)
    // IMPORTANT: <list> uses BASE namespace (eu.siacs.conversations.axolotl)
    // while the PEP node is eu.siacs.conversations.axolotl.devicelist
    const deviceElements = Array.from(allDeviceIds).map((id) => {
      const attrs: Record<string, string> = { id: String(id) };
      if (id === deviceId && deviceLabel) {
        attrs.label = deviceLabel;
      }
      return xml("device", attrs);
    });

    const payload = xml("list", { xmlns: NS_OMEMO }, ...deviceElements);

    const result = await pepPublish(
      accountId,
      NS_OMEMO_DEVICES,
      "current",
      payload,
      {
        accessModel: "open",
        persistItems: true,
        maxItems: 1,
      },
      log
    );

    if (result.ok) {
      log?.info?.(`[${accountId}] OMEMO published device ${deviceId} (total: ${allDeviceIds.size})`);
    }

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] OMEMO failed to publish device: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Fetch our own device list
 */
async function fetchOwnDeviceList(
  accountId: string,
  log?: Logger
): Promise<Array<{ id: number; label?: string }>> {
  // Fetch from our own JID (empty string = self)
  return fetchDeviceList(accountId, "", log);
}

/**
 * Fetch device list for a JID from PEP.
 * 
 * @param accountId - Our account ID
 * @param jid - Target JID (empty string = self)
 * @param log - Logger
 */
export async function fetchDeviceList(
  accountId: string,
  jid: string,
  log?: Logger
): Promise<Array<{ id: number; label?: string }>> {
  try {
    const result = await pepFetch(
      accountId,
      jid || undefined as unknown as string, // Empty = self
      NS_OMEMO_DEVICES,
      undefined,
      log
    );

    if (!result.ok || !result.data?.length) {
      return [];
    }

    const devices = result.data[0].payload;
    // Legacy OMEMO uses 'list' element, OMEMO 2.0 uses 'devices'
    if (!devices || (devices.name !== "list" && devices.name !== "devices")) {
      return [];
    }

    const deviceElements = devices.getChildren("device");
    const parsed: Array<{ id: number; label?: string }> = [];

    for (const el of deviceElements) {
      const id = parseInt(el.attrs?.id, 10);
      if (!isNaN(id)) {
        parsed.push({
          id,
          label: el.attrs?.label,
        });
      }
    }

    log?.debug?.(`[${accountId}] OMEMO fetched ${parsed.length} devices for ${jid || "self"}`);
    return parsed;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.warn?.(`[${accountId}] OMEMO failed to fetch devices for ${jid || "self"}: ${error}`);
    return [];
  }
}

/**
 * Parse device list from a PEP event stanza
 */
export function parseDeviceListEvent(
  itemPayload: Element
): Array<{ id: number; label?: string }> {
  // Legacy OMEMO uses 'list' element, OMEMO 2.0 uses 'devices'
  if (!itemPayload || (itemPayload.name !== "list" && itemPayload.name !== "devices")) {
    return [];
  }

  const deviceElements = itemPayload.getChildren("device");
  const devices: Array<{ id: number; label?: string }> = [];

  for (const el of deviceElements) {
    const id = parseInt(el.attrs?.id, 10);
    if (!isNaN(id)) {
      devices.push({
        id,
        label: el.attrs?.label,
      });
    }
  }

  return devices;
}
