/**
 * XEP-0163: Personal Eventing Protocol (PEP)
 * 
 * PEP is a simplified subset of PubSub (XEP-0060) for user-centric eventing.
 * Each user's bare JID acts as their PubSub service.
 * 
 * Use cases:
 * - User avatars (XEP-0084)
 * - User mood/activity (XEP-0107, XEP-0108)
 * - User location (XEP-0080)
 * - OMEMO device lists (XEP-0384)
 * - Bookmarks (XEP-0048)
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import { getActiveClient } from "./monitor.js";
import type { Logger } from "./types.js";
import { iqId, extractErrorText, waitForIq } from "./xml-utils.js";

// PubSub namespaces
export const NS_PUBSUB = "http://jabber.org/protocol/pubsub";
export const NS_PUBSUB_EVENT = "http://jabber.org/protocol/pubsub#event";
export const NS_PUBSUB_OWNER = "http://jabber.org/protocol/pubsub#owner";

// Common PEP node namespaces
export const NS_NICK = "http://jabber.org/protocol/nick";
export const NS_AVATAR_DATA = "urn:xmpp:avatar:data";
export const NS_AVATAR_METADATA = "urn:xmpp:avatar:metadata";
export const NS_MOOD = "http://jabber.org/protocol/mood";
export const NS_ACTIVITY = "http://jabber.org/protocol/activity";
export const NS_GEOLOC = "http://jabber.org/protocol/geoloc";
export const NS_TUNE = "http://jabber.org/protocol/tune";

/** PEP publish options for access control */
export interface PepPublishOptions {
  /** Access model: "open" (anyone), "presence" (contacts), "whitelist", "roster" */
  accessModel?: "open" | "presence" | "whitelist" | "roster";
  /** Persist items across sessions */
  persistItems?: boolean;
  /** Maximum number of items to store */
  maxItems?: number;
  /** Notify subscribers even if item unchanged */
  notifyRetract?: boolean;
  /** Deliver payloads in notifications */
  deliverPayloads?: boolean;
}

export interface PepItem {
  id: string;
  payload: Element;
}

export interface PepResult<T = void> {
  ok: boolean;
  error?: string;
  data?: T;
}

// iqId, extractErrorText, waitForIq imported from xml-utils.ts

/**
 * Send an IQ stanza and wait for response
 */
async function sendIq(
  accountId: string,
  iq: Element,
  log?: Logger
): Promise<Element> {
  const client = getActiveClient(accountId);
  if (!client) {
    throw new Error("XMPP client not connected");
  }

  const requestId = iq.attrs.id;
  log?.debug?.(`[PEP] Sending IQ: ${iq.toString()}`);

  const responsePromise = waitForIq(client, requestId);
  await client.send(iq);
  const response = await responsePromise;

  log?.debug?.(`[PEP] IQ response: type=${response.attrs.type}`);
  return response;
}

/**
 * Build publish options data form
 */
function buildPublishOptions(options: PepPublishOptions): Element {
  const fields: Element[] = [
    xml("field", { var: "FORM_TYPE", type: "hidden" },
      xml("value", {}, "http://jabber.org/protocol/pubsub#publish-options")
    ),
  ];

  if (options.accessModel) {
    fields.push(
      xml("field", { var: "pubsub#access_model" },
        xml("value", {}, options.accessModel)
      )
    );
  }

  if (options.persistItems !== undefined) {
    fields.push(
      xml("field", { var: "pubsub#persist_items" },
        xml("value", {}, options.persistItems ? "true" : "false")
      )
    );
  }

  if (options.maxItems !== undefined) {
    fields.push(
      xml("field", { var: "pubsub#max_items" },
        xml("value", {}, String(options.maxItems))
      )
    );
  }

  return xml("publish-options", {},
    xml("x", { xmlns: "jabber:x:data", type: "submit" }, ...fields)
  );
}

/**
 * Publish an item to a PEP node
 * 
 * @param accountId - The XMPP account ID
 * @param node - The PEP node name (e.g., "http://jabber.org/protocol/nick")
 * @param itemId - The item ID (use "current" for singleton nodes)
 * @param payload - The XML payload to publish
 * @param options - Optional publish options
 * @param log - Optional logger
 */
export async function pepPublish(
  accountId: string,
  node: string,
  itemId: string,
  payload: Element,
  options?: PepPublishOptions,
  log?: Logger
): Promise<PepResult> {
  try {
    const id = iqId();
    
    const pubsubChildren: Element[] = [
      xml("publish", { node },
        xml("item", { id: itemId }, payload)
      ),
    ];

    if (options) {
      pubsubChildren.push(buildPublishOptions(options));
    }

    const iq = xml("iq", { type: "set", id },
      xml("pubsub", { xmlns: NS_PUBSUB }, ...pubsubChildren)
    );

    const response = await sendIq(accountId, iq, log);

    if (response.attrs.type === "result") {
      log?.info?.(`[PEP] Published to node ${node}, itemId=${itemId}`);
      return { ok: true };
    } else {
      const error = response.getChild("error");
      const errorText = extractErrorText(error);
      log?.error?.(`[PEP] Publish failed: ${errorText}`);
      return { ok: false, error: errorText };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[PEP] Publish error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Fetch items from a PEP node
 * 
 * @param accountId - The XMPP account ID
 * @param jid - The JID of the PEP service (bare JID of user)
 * @param node - The PEP node name
 * @param itemIds - Optional specific item IDs to fetch
 * @param log - Optional logger
 */
export async function pepFetch(
  accountId: string,
  jid: string,
  node: string,
  itemIds?: string[],
  log?: Logger
): Promise<PepResult<PepItem[]>> {
  try {
    const id = iqId();

    let itemsElement: Element;
    if (itemIds && itemIds.length > 0) {
      itemsElement = xml("items", { node },
        ...itemIds.map(itemId => xml("item", { id: itemId }))
      );
    } else {
      itemsElement = xml("items", { node });
    }

    const iq = xml("iq", { type: "get", to: jid, id },
      xml("pubsub", { xmlns: NS_PUBSUB }, itemsElement)
    );

    const response = await sendIq(accountId, iq, log);

    if (response.attrs.type === "result") {
      const pubsub = response.getChild("pubsub", NS_PUBSUB);
      const items = pubsub?.getChild("items");
      const result: PepItem[] = [];

      if (items) {
        for (const item of items.getChildren("item")) {
          const itemId = item.attrs.id;
          const itemChildren = item.children || [];
          const payload = itemChildren[0] as Element | undefined;
          if (itemId && payload && typeof payload !== "string") {
            result.push({ id: itemId, payload });
          }
        }
      }

      log?.debug?.(`[PEP] Fetched ${result.length} items from ${jid}/${node}`);
      return { ok: true, data: result };
    } else {
      const error = response.getChild("error");
      const errorText = extractErrorText(error);
      log?.error?.(`[PEP] Fetch failed: ${errorText}`);
      return { ok: false, error: errorText };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[PEP] Fetch error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Subscribe to a PEP node
 * 
 * @param accountId - The XMPP account ID
 * @param jid - The JID of the PEP service (bare JID of user)
 * @param node - The PEP node name
 * @param log - Optional logger
 */
export async function pepSubscribe(
  accountId: string,
  jid: string,
  node: string,
  log?: Logger
): Promise<PepResult> {
  try {
    const client = getActiveClient(accountId);
    if (!client) {
      return { ok: false, error: "XMPP client not connected" };
    }

    const id = iqId();
    // Get our own JID for subscription
    const myJid = client.jid?.toString() || "";

    const iq = xml("iq", { type: "set", to: jid, id },
      xml("pubsub", { xmlns: NS_PUBSUB },
        xml("subscribe", { node, jid: myJid })
      )
    );

    const response = await sendIq(accountId, iq, log);

    if (response.attrs.type === "result") {
      log?.info?.(`[PEP] Subscribed to ${jid}/${node}`);
      return { ok: true };
    } else {
      const error = response.getChild("error");
      const errorText = extractErrorText(error);
      log?.error?.(`[PEP] Subscribe failed: ${errorText}`);
      return { ok: false, error: errorText };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[PEP] Subscribe error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Retract (delete) an item from a PEP node
 * 
 * @param accountId - The XMPP account ID
 * @param node - The PEP node name
 * @param itemId - The item ID to retract
 * @param log - Optional logger
 */
export async function pepRetract(
  accountId: string,
  node: string,
  itemId: string,
  log?: Logger
): Promise<PepResult> {
  try {
    const id = iqId();

    const iq = xml("iq", { type: "set", id },
      xml("pubsub", { xmlns: NS_PUBSUB },
        xml("retract", { node },
          xml("item", { id: itemId })
        )
      )
    );

    const response = await sendIq(accountId, iq, log);

    if (response.attrs.type === "result") {
      log?.info?.(`[PEP] Retracted item ${itemId} from node ${node}`);
      return { ok: true };
    } else {
      const error = response.getChild("error");
      const errorText = extractErrorText(error);
      log?.error?.(`[PEP] Retract failed: ${errorText}`);
      return { ok: false, error: errorText };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[PEP] Retract error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Delete an entire PEP node
 * 
 * @param accountId - The XMPP account ID
 * @param node - The PEP node name
 * @param log - Optional logger
 */
export async function pepDeleteNode(
  accountId: string,
  node: string,
  log?: Logger
): Promise<PepResult> {
  try {
    const id = iqId();

    const iq = xml("iq", { type: "set", id },
      xml("pubsub", { xmlns: NS_PUBSUB_OWNER },
        xml("delete", { node })
      )
    );

    const response = await sendIq(accountId, iq, log);

    if (response.attrs.type === "result") {
      log?.info?.(`[PEP] Deleted node ${node}`);
      return { ok: true };
    } else {
      const error = response.getChild("error");
      const errorText = extractErrorText(error);
      log?.error?.(`[PEP] Delete node failed: ${errorText}`);
      return { ok: false, error: errorText };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[PEP] Delete node error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Get node configuration
 * 
 * @param accountId - The XMPP account ID
 * @param node - The PEP node name
 * @param log - Optional logger
 */
export async function pepGetNodeConfig(
  accountId: string,
  node: string,
  log?: Logger
): Promise<PepResult<Element>> {
  try {
    const id = iqId();

    const iq = xml("iq", { type: "get", id },
      xml("pubsub", { xmlns: NS_PUBSUB_OWNER },
        xml("configure", { node })
      )
    );

    const response = await sendIq(accountId, iq, log);

    if (response.attrs.type === "result") {
      const pubsub = response.getChild("pubsub", NS_PUBSUB_OWNER);
      const configure = pubsub?.getChild("configure");
      const dataForm = configure?.getChild("x", "jabber:x:data");
      
      log?.debug?.(`[PEP] Got config for node ${node}`);
      return { ok: true, data: dataForm };
    } else {
      const error = response.getChild("error");
      const errorText = extractErrorText(error);
      log?.error?.(`[PEP] Get config failed: ${errorText}`);
      return { ok: false, error: errorText };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[PEP] Get config error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Parse a PEP event notification from a message stanza
 * 
 * @param stanza - The message stanza
 * @returns Parsed event info or null if not a PEP event
 */
export function parsePepEvent(stanza: Element): {
  from: string;
  node: string;
  items: PepItem[];
  retracted: string[];
} | null {
  if (!stanza.is("message")) return null;

  const event = stanza.getChild("event", NS_PUBSUB_EVENT);
  if (!event) return null;

  const items = event.getChild("items");
  if (!items) return null;

  const node = items.attrs.node;
  const from = stanza.attrs.from;

  const pepItems: PepItem[] = [];
  const retracted: string[] = [];

  const children = items.children || [];
  for (const child of children) {
    if (typeof child === "string") continue;
    
    const childEl = child as Element;
    if (childEl.name === "item") {
      const itemId = childEl.attrs.id;
      const childChildren = childEl.children || [];
      const payload = childChildren[0] as Element | undefined;
      if (itemId && payload && typeof payload !== "string") {
        pepItems.push({ id: itemId, payload });
      }
    } else if (childEl.name === "retract") {
      const itemId = childEl.attrs.id;
      if (itemId) {
        retracted.push(itemId);
      }
    }
  }

  return { from, node, items: pepItems, retracted };
}

// ============================================================================
// Convenience functions for common PEP use cases
// ============================================================================

/**
 * Publish user nickname (XEP-0172)
 */
export async function publishNickname(
  accountId: string,
  nickname: string,
  log?: Logger
): Promise<PepResult> {
  const payload = xml("nick", { xmlns: NS_NICK }, nickname);
  return pepPublish(accountId, NS_NICK, "current", payload, {
    accessModel: "presence",
    persistItems: true,
    maxItems: 1,
  }, log);
}

/**
 * Publish user mood (XEP-0107)
 */
export async function publishMood(
  accountId: string,
  mood: string,
  text?: string,
  log?: Logger
): Promise<PepResult> {
  const children: Element[] = [xml(mood, {})];
  if (text) {
    children.push(xml("text", {}, text));
  }
  const payload = xml("mood", { xmlns: NS_MOOD }, ...children);
  return pepPublish(accountId, NS_MOOD, "current", payload, {
    accessModel: "presence",
    persistItems: true,
    maxItems: 1,
  }, log);
}

/**
 * Clear user mood
 */
export async function clearMood(
  accountId: string,
  log?: Logger
): Promise<PepResult> {
  const payload = xml("mood", { xmlns: NS_MOOD });
  return pepPublish(accountId, NS_MOOD, "current", payload, {
    accessModel: "presence",
    persistItems: true,
    maxItems: 1,
  }, log);
}
