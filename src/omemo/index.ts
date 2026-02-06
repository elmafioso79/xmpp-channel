/**
 * OMEMO Encryption Module (XEP-0384)
 * 
 * End-to-end encryption using the Signal Protocol.
 * This implementation uses ALWAYS-TRUST policy - the bot accepts
 * encryption from any user without verification prompts.
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import * as fs from "fs";
import * as path from "path";
import type { Logger } from "../types.js";
import { OmemoStore } from "./store.js";
import { publishDeviceId, fetchDeviceList } from "./device.js";
import { publishBundle, fetchBundle, buildBundleFromStore } from "./bundle.js";
import { NS_OMEMO, NS_OMEMO_DEVICES, OMEMO_NAMESPACES, NS_OMEMO_LEGACY, NS_OMEMO_V2, type OmemoStoreData, type OmemoDevice } from "./types.js";
import {
  getDeviceList,
  handleDeviceListPepEvent,
  clearDeviceCache,
  getDeviceCacheStats,
} from "./device-cache.js";
import {
  getRoomOccupantJids,
  isRoomOmemoCapable,
  getRoomAnonymity,
  clearAllRoomStates,
  getOccupantStats,
  getOccupantRealJid,
} from "./muc-occupants.js";

// =============================================================================
// RE-EXPORTS
// =============================================================================

export { NS_OMEMO, NS_OMEMO_DEVICES, NS_OMEMO_BUNDLES, NS_OMEMO_LEGACY, NS_OMEMO_V2, OMEMO_NAMESPACES } from "./types.js";
export type { OmemoBundle, OmemoDevice, OmemoEncryptedMessage } from "./types.js";
export { OmemoStore } from "./store.js";
export { fetchDeviceList, parseDeviceListEvent } from "./device.js";
export { fetchBundle } from "./bundle.js";
export {
  getDeviceList as getCachedDeviceList,
  handleDeviceListPepEvent,
  clearDeviceCache,
  getDeviceCacheStats,
  getCachedDevices,
  setCachedDevices,
  invalidateCachedDevices,
} from "./device-cache.js";

// MUC Occupant tracking exports
export {
  handleMucPresence,
  getRoomOccupantJids,
  isRoomOmemoCapable,
  getRoomAnonymity,
  getRoomOccupantCount,
  getRoomState,
  clearRoomState,
  clearAllRoomStates,
  getOccupantStats,
  getOccupantRealJid,
} from "./muc-occupants.js";
export type { MucOccupant, RoomAnonymity } from "./muc-occupants.js";

// =============================================================================
// GLOBAL STATE
// =============================================================================

/** Active OMEMO stores by account ID */
const omemoStores = new Map<string, OmemoStore>();

/** Accounts with OMEMO enabled */
const omemoEnabled = new Set<string>();

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
// FILE-BASED PERSISTENCE
// =============================================================================

const OMEMO_STORE_FILENAME = "xmpp-omemo.json";

interface OmemoFileStore {
  accounts: Record<string, OmemoStoreData>;
}

function getOmemoStorePath(): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  return path.join(homeDir, ".openclaw", "extensions", "xmpp", OMEMO_STORE_FILENAME);
}

function loadOmemoFileStore(log?: Logger): OmemoFileStore {
  try {
    const storePath = getOmemoStorePath();
    if (fs.existsSync(storePath)) {
      const data = fs.readFileSync(storePath, "utf-8");
      return JSON.parse(data) as OmemoFileStore;
    }
  } catch (err) {
    log?.warn?.(`[OMEMO] Failed to load persisted store: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { accounts: {} };
}

function saveOmemoFileStore(store: OmemoFileStore, log?: Logger): void {
  try {
    const storePath = getOmemoStorePath();
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
    log?.debug?.(`[OMEMO] Saved persisted store`);
  } catch (err) {
    log?.error?.(`[OMEMO] Failed to save persisted store: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadOmemoStoreData(accountId: string, log?: Logger): OmemoStoreData | null {
  const storePath = getOmemoStorePath();
  log?.debug?.(`[OMEMO] Loading store from: ${storePath}`);
  const exists = fs.existsSync(storePath);
  log?.debug?.(`[OMEMO] Store file exists: ${exists}`);
  
  const fileStore = loadOmemoFileStore(log);
  const hasAccount = accountId in fileStore.accounts;
  log?.debug?.(`[OMEMO] Account ${accountId} in store: ${hasAccount}, keys: ${Object.keys(fileStore.accounts).join(", ")}`);
  
  return fileStore.accounts[accountId] ?? null;
}

function saveOmemoStoreData(accountId: string, data: OmemoStoreData, log?: Logger): void {
  const fileStore = loadOmemoFileStore(log);
  fileStore.accounts[accountId] = data;
  saveOmemoFileStore(fileStore, log);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize OMEMO for an account.
 * 
 * This:
 * 1. Loads or generates identity keys
 * 2. Publishes device ID to device list
 * 3. Publishes key bundle
 */
export async function initializeOmemo(
  accountId: string,
  selfJid: string,
  deviceLabel?: string,
  log?: Logger
): Promise<OmemoStore> {
  try {
    // Create store
    const store = new OmemoStore(accountId, log);
    store.setSelfJid(selfJid);
    
    // Try to load existing data from file
    const existingData = loadOmemoStoreData(accountId, log);
    const isFreshStart = !existingData;
    log?.debug?.(`[${accountId}] OMEMO init: existingData=${existingData ? `deviceId=${existingData.deviceId}` : "null"}, freshStart=${isFreshStart}`);
    
    await store.initialize(existingData ?? undefined);
    
    // Setup persistence callback
    store.setPersistCallback(async () => {
      const data = store.exportData();
      saveOmemoStoreData(accountId, data, log);
    });
    
    // Persist initial data
    const data = store.exportData();
    saveOmemoStoreData(accountId, data, log);
    
    // Publish device ID
    // If fresh start, replace entire device list to clear stale device IDs
    await publishDeviceId(accountId, store.getDeviceId(), deviceLabel, log, isFreshStart);
    
    // Publish key bundle
    const signedPreKey = store.getSignedPreKey();
    if (signedPreKey) {
      const identityKeyPair = store.getIdentityKeyPairSync();
      const bundle = buildBundleFromStore(
        identityKeyPair.publicKey,
        {
          id: signedPreKey.id,
          publicKey: signedPreKey.keyPair.publicKey,
          signature: signedPreKey.signature,
        },
        store.getPreKeys()
      );
      await publishBundle(accountId, store.getDeviceId(), bundle, log);
    }
    
    // Track store
    omemoStores.set(accountId, store);
    omemoEnabled.add(accountId);
    
    log?.info?.(`[${accountId}] OMEMO initialized (device ${store.getDeviceId()})`);
    return store;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] OMEMO initialization failed: ${error}`);
    throw err;
  }
}

/**
 * Check if OMEMO is enabled for an account
 */
export function isOmemoEnabled(accountId: string): boolean {
  return omemoEnabled.has(accountId);
}

/**
 * Get OMEMO store for an account
 */
export function getOmemoStore(accountId: string): OmemoStore | undefined {
  return omemoStores.get(accountId);
}

/**
 * Refresh device list for a JID (fetches from server and updates cache)
 * 
 * Use this when you suspect the device list may have changed or
 * to pre-fetch device lists for known contacts.
 * 
 * @param accountId - Our account ID
 * @param jid - Target JID (empty string = self)
 * @param log - Logger
 * @returns Device list
 */
export async function refreshDeviceList(
  accountId: string,
  jid: string,
  log?: Logger
): Promise<OmemoDevice[]> {
  return getDeviceList(accountId, jid, true, log);
}

/**
 * Pre-fetch device lists for multiple JIDs
 * 
 * Useful for pre-warming the cache when starting up.
 * 
 * @param accountId - Our account ID
 * @param jids - Array of JIDs to fetch device lists for
 * @param log - Logger
 */
export async function prefetchDeviceLists(
  accountId: string,
  jids: string[],
  log?: Logger
): Promise<void> {
  log?.debug?.(`[${accountId}] OMEMO pre-fetching device lists for ${jids.length} JIDs`);
  
  const results = await Promise.allSettled(
    jids.map(jid => getDeviceList(accountId, jid, false, log))
  );
  
  let success = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      success++;
    } else {
      failed++;
    }
  }
  
  log?.debug?.(`[${accountId}] OMEMO pre-fetched: ${success} succeeded, ${failed} failed`);
}

/**
 * Shutdown OMEMO for an account
 */
export async function shutdownOmemo(accountId: string, log?: Logger): Promise<void> {
  const store = omemoStores.get(accountId);
  if (store) {
    // Persist final state
    try {
      const data = store.exportData();
      saveOmemoStoreData(accountId, data, log);
    } catch (err) {
      log?.warn?.(`[${accountId}] OMEMO failed to persist on shutdown: ${err}`);
    }
  }
  
  // Clear device list cache for this account
  clearDeviceCache(accountId);
  
  // Clear MUC occupant tracking for this account
  clearAllRoomStates(accountId);
  
  omemoStores.delete(accountId);
  omemoEnabled.delete(accountId);
  log?.debug?.(`[${accountId}] OMEMO shutdown`);
}

// =============================================================================
// MESSAGE DETECTION
// =============================================================================

/**
 * Get OMEMO encrypted element from stanza (checks all namespaces)
 */
export function getOmemoEncrypted(stanza: Element): { element: Element; namespace: string } | null {
  for (const ns of OMEMO_NAMESPACES) {
    const encrypted = stanza.getChild("encrypted", ns);
    if (encrypted) {
      return { element: encrypted, namespace: ns };
    }
  }
  return null;
}

/**
 * Check if a message stanza contains OMEMO encryption
 */
export function isOmemoEncrypted(stanza: Element): boolean {
  return getOmemoEncrypted(stanza) !== null;
}

// =============================================================================
// DECRYPTION
// =============================================================================

/**
 * Check if an element indicates a pre-key message
 * Legacy OMEMO uses prekey="true" or prekey="1"
 * OMEMO 2.0 uses kex="true" or kex="1"
 */
function isPreKeyElement(keyEl: Element, namespace: string): boolean {
  // Legacy format: prekey attribute
  const prekey = keyEl.attrs?.prekey as string | undefined;
  if (prekey === "true" || prekey === "1") return true;
  
  // OMEMO 2.0: kex attribute (key exchange)
  if (namespace === NS_OMEMO_V2) {
    const kex = keyEl.attrs?.kex as string | undefined;
    if (kex === "true" || kex === "1") return true;
  }
  
  return false;
}

/**
 * Decrypt an OMEMO encrypted message.
 * 
 * Supports both legacy (0.3.0) and OMEMO 2.0 message formats.
 * 
 * @param accountId - Our account ID
 * @param stanza - The message stanza
 * @param log - Logger
 * @returns Decrypted plaintext or null if decryption failed
 */
export async function decryptOmemoMessage(
  accountId: string,
  stanza: Element,
  log?: Logger
): Promise<string | null> {
  const store = omemoStores.get(accountId);
  if (!store) {
    log?.warn?.(`[${accountId}] OMEMO not initialized`);
    return null;
  }

  const encryptedInfo = getOmemoEncrypted(stanza);
  if (!encryptedInfo) return null;
  
  const { element: encrypted, namespace } = encryptedInfo;
  const isV2 = namespace === NS_OMEMO_V2;
  
  log?.debug?.(`[${accountId}] OMEMO parsing encrypted message (namespace: ${namespace})`);

  try {
    const header = encrypted.getChild("header");
    
    // Payload: legacy uses <payload> child, OMEMO 2.0 also uses <payload>
    const payloadText = encrypted.getChildText("payload");

    if (!header) {
      log?.warn?.(`[${accountId}] OMEMO message missing header`);
      return null;
    }

    const senderDeviceId = parseInt(header.attrs?.sid, 10);
    if (isNaN(senderDeviceId)) {
      log?.warn?.(`[${accountId}] OMEMO message has invalid sender device ID`);
      return null;
    }

    // IV: legacy uses <iv> child, OMEMO 2.0 uses <iv> child
    const ivText = header.getChildText("iv");
    if (!ivText) {
      log?.warn?.(`[${accountId}] OMEMO message missing IV`);
      return null;
    }

    const iv = fromBase64(ivText);

    // Find key element for our device
    // Legacy: <key rid="deviceId">
    // OMEMO 2.0: <key rid="deviceId"> or <keys jid="..."><key rid="deviceId">
    const ourDeviceId = store.getDeviceId();
    let ourKeyElement: Element | undefined;
    let keyElements = header.getChildren("key");
    
    // OMEMO 2.0 nests keys under <keys jid="...">
    if (isV2 && keyElements.length === 0) {
      for (const keysEl of header.getChildren("keys")) {
        keyElements = keysEl.getChildren("key");
        ourKeyElement = keyElements.find(
          (k) => parseInt(k.attrs?.rid, 10) === ourDeviceId
        );
        if (ourKeyElement) break;
      }
    } else {
      ourKeyElement = keyElements.find(
        (k) => parseInt(k.attrs?.rid, 10) === ourDeviceId
      );
    }

    if (!ourKeyElement) {
      log?.debug?.(`[${accountId}] OMEMO message not encrypted for our device ${ourDeviceId} (found keys for: ${keyElements.map(k => k.attrs?.rid).join(", ")})`);
      return null;
    }

    const encryptedKey = fromBase64(getElementText(ourKeyElement));
    const isPreKeyMessage = isPreKeyElement(ourKeyElement, namespace);
    
    // Determine sender JID - different for DMs vs MUC
    const fromAttr = stanza.attrs?.from as string | undefined;
    const msgType = stanza.attrs?.type as string | undefined;
    let senderJid: string | null = null;
    
    if (msgType === "groupchat" && fromAttr) {
      // MUC message: from is room@conference/nick, need to look up real JID
      const slashIdx = fromAttr.indexOf("/");
      if (slashIdx !== -1) {
        const roomJid = fromAttr.substring(0, slashIdx);
        const nick = fromAttr.substring(slashIdx + 1);
        senderJid = getOccupantRealJid(accountId, roomJid, nick);
        if (!senderJid) {
          log?.warn?.(`[${accountId}] OMEMO MUC: cannot decrypt - no real JID for ${roomJid}/${nick}`);
          return null;
        }
        log?.debug?.(`[${accountId}] OMEMO MUC sender: ${nick} -> ${senderJid}`);
      }
    } else if (fromAttr) {
      // DM: from is user@domain/resource, extract bare JID
      senderJid = fromAttr.split("/")[0];
    }

    log?.debug?.(`[${accountId}] OMEMO key element: rid=${ourDeviceId}, prekey=${isPreKeyMessage}, sender=${senderJid}:${senderDeviceId}, keyLen=${encryptedKey.length}`);

    if (!senderJid) {
      log?.warn?.(`[${accountId}] OMEMO message missing sender JID`);
      return null;
    }

    // Decrypt the message key using Signal session
    const messageKey = await decryptMessageKey(
      store,
      senderJid,
      senderDeviceId,
      encryptedKey,
      isPreKeyMessage,
      log
    );

    if (!messageKey) {
      log?.warn?.(`[${accountId}] OMEMO failed to decrypt message key`);
      return null;
    }

    // If there's no payload, this is a key transport message (e.g., for session setup)
    if (!payloadText) {
      log?.debug?.(`[${accountId}] OMEMO key transport message (no payload)`);
      return null;
    }

    // Decrypt payload with AES-GCM
    const ciphertext = fromBase64(payloadText);
    
    log?.debug?.(`[${accountId}] OMEMO AES: ivLen=${iv.length}, keyLen=${messageKey.length}, ciphertextLen=${ciphertext.length}`);
    
    const plaintext = await decryptPayload(ciphertext, messageKey, iv, log);

    log?.debug?.(`[${accountId}] OMEMO decrypted message from ${senderJid}:${senderDeviceId}`);
    return plaintext;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] OMEMO decryption failed: ${error}`);
    return null;
  }
}

/**
 * Decrypt message key using Signal session
 * 
 * Attempts decryption in this order:
 * 1. If marked as pre-key message, try pre-key first
 * 2. Otherwise try regular message first
 * 3. Fall back to opposite type if first attempt fails
 */
async function decryptMessageKey(
  store: OmemoStore,
  senderJid: string,
  senderDeviceId: number,
  encryptedKey: Uint8Array,
  isPreKeyHint: boolean,
  log?: Logger
): Promise<Uint8Array | null> {
  const cipher = store.createSessionCipher(senderJid, senderDeviceId);

  // Properly convert Uint8Array to ArrayBuffer (handle potential byte offset)
  const keyBuffer = encryptedKey.buffer.slice(
    encryptedKey.byteOffset,
    encryptedKey.byteOffset + encryptedKey.byteLength
  ) as ArrayBuffer;

  log?.debug?.(`Signal decrypting: hintPreKey=${isPreKeyHint}, keyLen=${encryptedKey.length}, sender=${senderJid}:${senderDeviceId}`);

  // Check message type from first byte (Signal protocol indicator)
  // PreKeyWhisperMessage: first byte is 0x03 (51 decimal)
  // WhisperMessage: first byte is 0x01 (49 decimal) 
  const firstByte = encryptedKey[0];
  const looksLikePreKey = (firstByte & 0x0F) === 3;
  
  log?.debug?.(`Signal message first byte: 0x${firstByte.toString(16)} (looksLikePreKey=${looksLikePreKey})`);

  // Try based on hint or auto-detection
  const tryPreKeyFirst = isPreKeyHint || looksLikePreKey;

  try {
    let decrypted: ArrayBuffer;
    if (tryPreKeyFirst) {
      try {
        // Pre-key message - establishes new session
        decrypted = await cipher.decryptPreKeyWhisperMessage(keyBuffer, "binary");
        log?.debug?.(`Signal pre-key decryption success: decryptedLen=${decrypted.byteLength}`);
        return new Uint8Array(decrypted);
      } catch (preKeyErr) {
        log?.debug?.(`Signal pre-key attempt failed: ${preKeyErr}, trying regular...`);
        // Fall through to try regular message
      }
      
      // Try as regular message
      decrypted = await cipher.decryptWhisperMessage(keyBuffer, "binary");
      log?.debug?.(`Signal regular decryption success (fallback): decryptedLen=${decrypted.byteLength}`);
      return new Uint8Array(decrypted);
    } else {
      try {
        // Regular message - uses existing session
        decrypted = await cipher.decryptWhisperMessage(keyBuffer, "binary");
        log?.debug?.(`Signal regular decryption success: decryptedLen=${decrypted.byteLength}`);
        return new Uint8Array(decrypted);
      } catch (regularErr) {
        log?.debug?.(`Signal regular attempt failed: ${regularErr}, trying pre-key...`);
        // Fall through to try pre-key message
      }
      
      // Try as pre-key message
      decrypted = await cipher.decryptPreKeyWhisperMessage(keyBuffer, "binary");
      log?.debug?.(`Signal pre-key decryption success (fallback): decryptedLen=${decrypted.byteLength}`);
      return new Uint8Array(decrypted);
    }
  } catch (err) {
    log?.debug?.(`Signal decryption failed both methods: ${err}`);
    return null;
  }
}

/**
 * Decrypt payload using AES-128-GCM (legacy OMEMO 0.3)
 * 
 * In legacy OMEMO, the Signal-decrypted key contains:
 * - 16 bytes: AES-128 key
 * - 16 bytes: GCM authentication tag
 * 
 * The auth tag needs to be appended to the ciphertext for WebCrypto.
 */
async function decryptPayload(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  log?: Logger
): Promise<string> {
  // Legacy OMEMO: key is 16 bytes AES + 16 bytes auth tag
  // Or OMEMO 2.0: key is 32 bytes AES (tag appended to ciphertext)
  
  let aesKey: Uint8Array;
  let dataToDecrypt: Uint8Array;
  
  if (key.length === 32 && ciphertext.length > 0) {
    // Legacy OMEMO: Split key into AES key + auth tag
    aesKey = key.slice(0, 16);  // First 16 bytes = AES-128 key
    const authTag = key.slice(16, 32);  // Last 16 bytes = auth tag
    
    // Append auth tag to ciphertext (WebCrypto expects: ciphertext || tag)
    dataToDecrypt = new Uint8Array(ciphertext.length + authTag.length);
    dataToDecrypt.set(ciphertext, 0);
    dataToDecrypt.set(authTag, ciphertext.length);
    
    log?.debug?.(`OMEMO legacy AES-128-GCM: aesKeyLen=${aesKey.length}, ivLen=${iv.length}, cipherLen=${ciphertext.length}, tagLen=${authTag.length}`);
  } else if (key.length === 16) {
    // Rare: just 16-byte key, tag assumed to be at end of ciphertext
    aesKey = key;
    dataToDecrypt = ciphertext;
    log?.debug?.(`OMEMO AES-128-GCM (tag in payload): keyLen=${aesKey.length}, ivLen=${iv.length}, dataLen=${dataToDecrypt.length}`);
  } else {
    // OMEMO 2.0 or other: 32-byte AES-256 key, tag at end of ciphertext
    aesKey = key.slice(0, 32);
    dataToDecrypt = ciphertext;
    log?.debug?.(`OMEMO AES-256-GCM: keyLen=${aesKey.length}, ivLen=${iv.length}, dataLen=${dataToDecrypt.length}`);
  }
  
  // Minimum size: at least 16 bytes for auth tag
  if (dataToDecrypt.length < 16) {
    throw new Error(`Data too small: ${dataToDecrypt.length} bytes (need at least 16 for auth tag)`);
  }
  
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    aesKey.buffer.slice(aesKey.byteOffset, aesKey.byteOffset + aesKey.byteLength) as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer, tagLength: 128 },
    cryptoKey,
    dataToDecrypt.buffer.slice(dataToDecrypt.byteOffset, dataToDecrypt.byteOffset + dataToDecrypt.byteLength) as ArrayBuffer
  );

  const result = new TextDecoder().decode(decrypted);
  log?.debug?.(`OMEMO AES-GCM decrypted: ${result.length} chars`);
  return result;
}

// =============================================================================
// ENCRYPTION
// =============================================================================

/**
 * Encrypt a message for a recipient.
 * 
 * Encrypts for ALL known devices of the recipient, plus our own devices
 * (for multi-device synchronization). Uses cached device lists when available.
 * 
 * @param accountId - Our account ID
 * @param recipientJid - Recipient bare JID
 * @param plaintext - Message to encrypt
 * @param log - Logger
 * @returns OMEMO encrypted element or null if encryption failed
 */
export async function encryptOmemoMessage(
  accountId: string,
  recipientJid: string,
  plaintext: string,
  log?: Logger
): Promise<Element | null> {
  const store = omemoStores.get(accountId);
  if (!store) {
    log?.warn?.(`[${accountId}] OMEMO not initialized`);
    return null;
  }

  try {
    // Fetch recipient's devices (uses cache if available)
    const devices = await getDeviceList(accountId, recipientJid, false, log);
    if (devices.length === 0) {
      log?.warn?.(`[${accountId}] No OMEMO devices for ${recipientJid}`);
      return null;
    }

    // Also include our own devices (except current one) for multi-device sync
    const ownDevices = await getDeviceList(accountId, "", false, log);
    const ourDeviceId = store.getDeviceId();
    const otherOwnDevices = ownDevices.filter(d => d.id !== ourDeviceId);

    log?.debug?.(`[${accountId}] OMEMO multi-device: ${devices.length} recipient devices, ${otherOwnDevices.length} own other devices`);

    // Legacy OMEMO: Generate 16-byte AES key and 12-byte IV
    const aesKey = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt payload with AES-128-GCM
    const { ciphertext, authTag } = await encryptPayloadLegacy(plaintext, aesKey, iv, log);
    
    // Legacy OMEMO: messageKey = aesKey (16) + authTag (16) = 32 bytes
    const messageKey = new Uint8Array(32);
    messageKey.set(aesKey, 0);
    messageKey.set(authTag, 16);
    
    log?.debug?.(`[${accountId}] OMEMO encrypt: aesKeyLen=${aesKey.length}, ivLen=${iv.length}, cipherLen=${ciphertext.length}, tagLen=${authTag.length}`);

    // Track encryption results for logging
    let recipientDevicesEncrypted = 0;
    let ownDevicesEncrypted = 0;

    // Encrypt message key for each recipient device
    const keyElements: Element[] = [];

    for (const device of devices) {
      try {
        const result = await encryptKeyForDevice(
          store,
          accountId,
          recipientJid,
          device.id,
          messageKey,
          log
        );
        if (result) {
          keyElements.push(
            xml(
              "key",
              {
                rid: String(device.id),
                ...(result.isPreKey ? { prekey: "true" } : {}),
              },
              toBase64(result.encryptedKey)
            )
          );
          recipientDevicesEncrypted++;
        }
      } catch (err) {
        log?.warn?.(`[${accountId}] Failed to encrypt for ${recipientJid}:${device.id}: ${err}`);
      }
    }

    // Encrypt for our own other devices (multi-device sync)
    for (const device of otherOwnDevices) {
      try {
        const result = await encryptKeyForDevice(
          store,
          accountId,
          "", // Self
          device.id,
          messageKey,
          log
        );
        if (result) {
          keyElements.push(
            xml(
              "key",
              {
                rid: String(device.id),
                ...(result.isPreKey ? { prekey: "true" } : {}),
              },
              toBase64(result.encryptedKey)
            )
          );
          ownDevicesEncrypted++;
        }
      } catch {
        // Ignore errors for own devices (bundle may not be available)
      }
    }

    if (keyElements.length === 0) {
      log?.error?.(`[${accountId}] Could not encrypt for any device of ${recipientJid}`);
      return null;
    }

    // Build OMEMO message
    const encrypted = xml(
      "encrypted",
      { xmlns: NS_OMEMO },
      xml(
        "header",
        { sid: String(store.getDeviceId()) },
        ...keyElements,
        xml("iv", {}, toBase64(iv))
      ),
      xml("payload", {}, toBase64(ciphertext))
    );

    log?.info?.(`[${accountId}] OMEMO encrypted for ${recipientDevicesEncrypted}/${devices.length} recipient devices + ${ownDevicesEncrypted}/${otherOwnDevices.length} own devices`);
    return encrypted;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] OMEMO encryption failed: ${error}`);
    return null;
  }
}

/**
 * Encrypt a message for a MUC room.
 * 
 * Encrypts for ALL known devices of ALL room occupants (via real JIDs),
 * plus our own devices for multi-device synchronization.
 * 
 * This only works for non-anonymous MUC rooms where real JIDs are visible.
 * 
 * @param accountId - Our account ID
 * @param roomJid - Room bare JID
 * @param plaintext - Message to encrypt
 * @param log - Logger
 * @returns OMEMO encrypted element or null if encryption failed
 */
export async function encryptMucOmemoMessage(
  accountId: string,
  roomJid: string,
  plaintext: string,
  log?: Logger
): Promise<Element | null> {
  const store = omemoStores.get(accountId);
  if (!store) {
    log?.warn?.(`[${accountId}] OMEMO not initialized`);
    return null;
  }

  // Check if room is OMEMO-capable
  if (!isRoomOmemoCapable(accountId, roomJid)) {
    log?.warn?.(`[${accountId}] Room ${roomJid} is not OMEMO-capable (anonymous or no occupants)`);
    return null;
  }

  // Get real JIDs of room occupants
  const occupantJids = getRoomOccupantJids(accountId, roomJid, true);
  if (!occupantJids || occupantJids.length === 0) {
    log?.warn?.(`[${accountId}] No occupant JIDs available for room ${roomJid}`);
    return null;
  }

  log?.debug?.(`[${accountId}] MUC OMEMO: encrypting for ${occupantJids.length} occupants in ${roomJid}`);

  try {
    // Collect all devices from all occupants
    const allDevices: Array<{ jid: string; deviceId: number }> = [];
    
    for (const jid of occupantJids) {
      const devices = await getDeviceList(accountId, jid, false, log);
      for (const device of devices) {
        allDevices.push({ jid, deviceId: device.id });
      }
    }

    if (allDevices.length === 0) {
      log?.warn?.(`[${accountId}] No OMEMO devices found for any occupant in ${roomJid}`);
      return null;
    }

    // Also include our own devices for multi-device sync
    // Unlike DMs, MUC messages are reflected back by the server, so we MUST
    // encrypt for our own device(s) to read the reflected message
    const ownDevices = await getDeviceList(accountId, "", false, log);
    const ourDeviceId = store.getDeviceId();
    // For MUC, include ALL own devices including current one (for reflected messages)
    const ownDevicesToEncrypt = ownDevices;

    log?.debug?.(`[${accountId}] MUC OMEMO: ${allDevices.length} occupant devices, ${ownDevicesToEncrypt.length} own devices (incl. self)`);

    // Legacy OMEMO: Generate 16-byte AES key and 12-byte IV
    const aesKey = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt payload with AES-128-GCM
    const { ciphertext, authTag } = await encryptPayloadLegacy(plaintext, aesKey, iv, log);
    
    // Legacy OMEMO: messageKey = aesKey (16) + authTag (16) = 32 bytes
    const messageKey = new Uint8Array(32);
    messageKey.set(aesKey, 0);
    messageKey.set(authTag, 16);

    // Track encryption results
    let occupantDevicesEncrypted = 0;
    let ownDevicesEncrypted = 0;

    // Encrypt message key for each occupant device
    const keyElements: Element[] = [];

    for (const { jid, deviceId } of allDevices) {
      try {
        const result = await encryptKeyForDevice(
          store,
          accountId,
          jid,
          deviceId,
          messageKey,
          log
        );
        if (result) {
          keyElements.push(
            xml(
              "key",
              {
                rid: String(deviceId),
                ...(result.isPreKey ? { prekey: "true" } : {}),
              },
              toBase64(result.encryptedKey)
            )
          );
          occupantDevicesEncrypted++;
        }
      } catch (err) {
        log?.warn?.(`[${accountId}] Failed to encrypt for ${jid}:${deviceId}: ${err}`);
      }
    }

    // Encrypt for our own devices (for multi-device sync and reflected messages)
    for (const device of ownDevicesToEncrypt) {
      try {
        const result = await encryptKeyForDevice(
          store,
          accountId,
          "", // Self
          device.id,
          messageKey,
          log
        );
        if (result) {
          keyElements.push(
            xml(
              "key",
              {
                rid: String(device.id),
                ...(result.isPreKey ? { prekey: "true" } : {}),
              },
              toBase64(result.encryptedKey)
            )
          );
          ownDevicesEncrypted++;
        }
      } catch {
        // Ignore errors for own devices (bundle may not be available)
      }
    }

    if (keyElements.length === 0) {
      log?.error?.(`[${accountId}] Could not encrypt for any device in room ${roomJid}`);
      return null;
    }

    // Build OMEMO message
    const encrypted = xml(
      "encrypted",
      { xmlns: NS_OMEMO },
      xml(
        "header",
        { sid: String(store.getDeviceId()) },
        ...keyElements,
        xml("iv", {}, toBase64(iv))
      ),
      xml("payload", {}, toBase64(ciphertext))
    );

    log?.info?.(`[${accountId}] MUC OMEMO encrypted for ${occupantDevicesEncrypted}/${allDevices.length} occupant devices + ${ownDevicesEncrypted}/${ownDevicesToEncrypt.length} own devices in ${roomJid}`);
    return encrypted;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] MUC OMEMO encryption failed: ${error}`);
    return null;
  }
}

/**
 * Encrypt message key for a specific device
 */
async function encryptKeyForDevice(
  store: OmemoStore,
  accountId: string,
  recipientJid: string,
  deviceId: number,
  messageKey: Uint8Array,
  log?: Logger
): Promise<{ encryptedKey: Uint8Array; isPreKey: boolean } | null> {
  // Use the account's own JID if recipientJid is empty (self)
  // store.getSelfJid() returns the real JID (e.g., aurora@sazsxm.com)
  const targetJid = recipientJid || store.getSelfJid() || accountId;

  // Check if we have a session
  if (!store.hasSession(targetJid, deviceId)) {
    // Need to establish session - fetch bundle
    const bundle = await fetchBundle(accountId, targetJid, deviceId, log);
    if (!bundle) {
      log?.debug?.(`[${accountId}] No bundle for ${targetJid}:${deviceId}`);
      return null;
    }

    // Build session from bundle
    const sessionBuilder = store.createSessionBuilder(targetJid, deviceId);

    // Pick a random pre-key
    const preKeyIndex = Math.floor(Math.random() * bundle.preKeys.length);
    const preKey = bundle.preKeys[preKeyIndex];

    // Helper to convert Uint8Array to ArrayBuffer
    const toAB = (arr: Uint8Array): ArrayBuffer =>
      arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;

    await sessionBuilder.processPreKey({
      registrationId: 0, // Not used in our implementation
      identityKey: toAB(bundle.identityKey),
      signedPreKey: {
        keyId: bundle.signedPreKey.id,
        publicKey: toAB(bundle.signedPreKey.publicKey),
        signature: toAB(bundle.signedPreKey.signature),
      },
      preKey: {
        keyId: preKey.id,
        publicKey: toAB(preKey.publicKey),
      },
    });
  }

  // Encrypt the message key
  const cipher = store.createSessionCipher(targetJid, deviceId);
  const msgKeyBuffer = messageKey.buffer.slice(
    messageKey.byteOffset,
    messageKey.byteOffset + messageKey.byteLength
  ) as ArrayBuffer;
  const encrypted = await cipher.encrypt(msgKeyBuffer);

  // Signal library returns body as binary string (char codes = bytes), not base64
  let encryptedKeyBytes: Uint8Array;
  if (typeof encrypted.body === 'string') {
    const bodyStr = encrypted.body;
    // Check if it looks like base64 (alphanumeric, +, /, =)
    const isBase64 = /^[A-Za-z0-9+/=]+$/.test(bodyStr);
    if (isBase64) {
      encryptedKeyBytes = fromBase64(bodyStr);
    } else {
      // Binary string - convert char codes to bytes
      encryptedKeyBytes = new Uint8Array(bodyStr.length);
      for (let i = 0; i < bodyStr.length; i++) {
        encryptedKeyBytes[i] = bodyStr.charCodeAt(i);
      }
    }
  } else if (encrypted.body instanceof ArrayBuffer) {
    encryptedKeyBytes = new Uint8Array(encrypted.body);
  } else {
    log?.error?.(`[OMEMO] Unknown encrypted.body format: ${typeof encrypted.body}`);
    return null;
  }

  return {
    encryptedKey: encryptedKeyBytes,
    isPreKey: encrypted.type === 3, // PreKeyWhisperMessage type
  };
}

/**
 * Encrypt payload using AES-128-GCM (legacy OMEMO format)
 * 
 * Returns ciphertext and authTag separately since legacy OMEMO
 * puts the auth tag in the message key, not the payload.
 */
async function encryptPayloadLegacy(
  plaintext: string,
  key: Uint8Array,
  iv: Uint8Array,
  log?: Logger
): Promise<{ ciphertext: Uint8Array; authTag: Uint8Array }> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer, tagLength: 128 },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  );

  const encryptedBytes = new Uint8Array(encrypted);
  
  // WebCrypto AES-GCM output = ciphertext + authTag (16 bytes)
  // Legacy OMEMO wants them separate
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);
  
  log?.debug?.(`OMEMO encrypt payload: plainLen=${plaintext.length}, cipherLen=${ciphertext.length}, tagLen=${authTag.length}`);
  
  return { ciphertext, authTag };
}

/**
 * Encrypt payload using AES-256-GCM
 */
async function encryptPayload(
  plaintext: string,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer, tagLength: 128 },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  );

  return new Uint8Array(encrypted);
}

// =============================================================================
// MESSAGE BUILDING
// =============================================================================

/**
 * Build an OMEMO encrypted message stanza.
 * 
 * @param to - Recipient JID
 * @param encryptedElement - The <encrypted> element from encryptOmemoMessage
 * @param msgType - Message type ("chat" or "groupchat")
 */
export function buildOmemoMessageStanza(
  to: string,
  encryptedElement: Element,
  msgType: "chat" | "groupchat" = "chat"
): Element {
  const messageId = `omemo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return xml(
    "message",
    { to, type: msgType, id: messageId },
    encryptedElement,
    // EME (Encryption for Message Encryption) hint
    xml("encryption", {
      xmlns: "urn:xmpp:eme:0",
      namespace: NS_OMEMO,
      name: "OMEMO",
    }),
    // Store hint for MAM
    xml("store", { xmlns: "urn:xmpp:hints" }),
    // Fallback body for non-OMEMO clients
    xml("body", {}, "I sent you an OMEMO encrypted message but your client doesn't seem to support that.")
  );
}
