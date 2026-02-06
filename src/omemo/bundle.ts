/**
 * OMEMO Bundle Management (XEP-0384)
 * 
 * Handles key bundle publication and retrieval via PEP (XEP-0163).
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import { pepPublish, pepFetch } from "../pep.js";
import type { Logger } from "../types.js";
import type { OmemoBundle } from "./types.js";
import { NS_OMEMO, NS_OMEMO_BUNDLES } from "./types.js";

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Convert Uint8Array to base64 string
 */
function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/**
 * Convert base64 string to Uint8Array
 */
function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/**
 * Get text content from an Element (handles xmpp.js Element structure)
 */
function getElementText(el: Element): string {
  if (!el || !el.children) return "";
  for (const child of el.children) {
    if (typeof child === "string") {
      return child;
    }
  }
  return "";
}

// =============================================================================
// BUNDLE MANAGEMENT
// =============================================================================

/**
 * Publish our key bundle via PEP.
 * 
 * The bundle contains:
 * - Identity public key
 * - Signed pre-key
 * - One-time pre-keys
 */
export async function publishBundle(
  accountId: string,
  deviceId: number,
  bundle: OmemoBundle,
  log?: Logger
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Build pre-key elements (legacy OMEMO format)
    const preKeyElements = bundle.preKeys.map((pk) =>
      xml("preKeyPublic", { preKeyId: String(pk.id) }, toBase64(pk.publicKey))
    );

    // Build bundle XML (legacy OMEMO format)
    const payload = xml(
      "bundle",
      { xmlns: NS_OMEMO },
      xml("signedPreKeyPublic", { signedPreKeyId: String(bundle.signedPreKey.id) }, toBase64(bundle.signedPreKey.publicKey)),
      xml("signedPreKeySignature", {}, toBase64(bundle.signedPreKey.signature)),
      xml("identityKey", {}, toBase64(bundle.identityKey)),
      xml("prekeys", {}, ...preKeyElements)
    );

    const node = `${NS_OMEMO_BUNDLES}:${deviceId}`;
    const result = await pepPublish(
      accountId,
      node,
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
      log?.info?.(`[${accountId}] OMEMO published bundle for device ${deviceId} (${bundle.preKeys.length} pre-keys)`);
    }

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] OMEMO failed to publish bundle: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Fetch key bundle for a remote device.
 * 
 * @param accountId - Our account ID
 * @param jid - Target JID
 * @param deviceId - Target device ID
 * @param log - Logger
 */
export async function fetchBundle(
  accountId: string,
  jid: string,
  deviceId: number,
  log?: Logger
): Promise<OmemoBundle | null> {
  try {
    const node = `${NS_OMEMO_BUNDLES}:${deviceId}`;
    const result = await pepFetch(accountId, jid, node, undefined, log);

    if (!result.ok || !result.data?.length) {
      log?.warn?.(`[${accountId}] OMEMO bundle not found for ${jid}:${deviceId}`);
      return null;
    }

    const bundle = parseBundle(result.data[0].payload);
    if (bundle) {
      log?.debug?.(`[${accountId}] OMEMO fetched bundle for ${jid}:${deviceId} (${bundle.preKeys.length} pre-keys)`);
    }
    return bundle;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.warn?.(`[${accountId}] OMEMO failed to fetch bundle for ${jid}:${deviceId}: ${error}`);
    return null;
  }
}

/**
 * Parse bundle XML to OmemoBundle object
 */
function parseBundle(element: Element): OmemoBundle | null {
  try {
    if (!element || element.name !== "bundle") {
      return null;
    }

    // Identity key (legacy uses 'identityKey', OMEMO 2.0 uses 'ik')
    let ikText = element.getChildText("identityKey");
    if (!ikText) ikText = element.getChildText("ik");
    if (!ikText) return null;

    // Signed pre-key (legacy vs OMEMO 2.0 element names)
    let spk = element.getChild("signedPreKeyPublic");
    let spksText = element.getChildText("signedPreKeySignature");
    let spkIdAttr = "signedPreKeyId";
    
    // Fallback to OMEMO 2.0 format
    if (!spk) {
      spk = element.getChild("spk");
      spksText = element.getChildText("spks");
      spkIdAttr = "id";
    }
    if (!spk || !spksText) return null;

    const spkId = parseInt(spk.attrs?.[spkIdAttr], 10);
    const spkText = getElementText(spk);
    if (isNaN(spkId) || !spkText) return null;

    // Pre-keys (legacy uses 'preKeyPublic' with 'preKeyId', OMEMO 2.0 uses 'pk' with 'id')
    const prekeysElement = element.getChild("prekeys");
    if (!prekeysElement) return null;

    // Try legacy format first
    let preKeyElements = prekeysElement.getChildren("preKeyPublic");
    let preKeyIdAttr = "preKeyId";
    
    // Fallback to OMEMO 2.0 format
    if (preKeyElements.length === 0) {
      preKeyElements = prekeysElement.getChildren("pk");
      preKeyIdAttr = "id";
    }
    
    const preKeys: Array<{ id: number; publicKey: Uint8Array }> = [];

    for (const pk of preKeyElements) {
      const pkId = parseInt(pk.attrs?.[preKeyIdAttr], 10);
      const pkText = getElementText(pk);
      if (!isNaN(pkId) && pkText) {
        preKeys.push({
          id: pkId,
          publicKey: fromBase64(pkText),
        });
      }
    }

    return {
      identityKey: fromBase64(ikText),
      signedPreKey: {
        id: spkId,
        publicKey: fromBase64(spkText),
        signature: fromBase64(spksText),
      },
      preKeys,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Build a bundle from store data
 */
export function buildBundleFromStore(
  identityPublicKey: Uint8Array,
  signedPreKey: { id: number; publicKey: Uint8Array; signature: Uint8Array },
  preKeys: Array<{ id: number; publicKey: Uint8Array }>
): OmemoBundle {
  return {
    identityKey: identityPublicKey,
    signedPreKey,
    preKeys,
  };
}
