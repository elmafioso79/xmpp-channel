/**
 * OMEMO Encryption Types (XEP-0384)
 * 
 * Type definitions and constants for OMEMO encryption.
 * Supports both legacy (0.3.0) and OMEMO 2.0 namespaces.
 */

// =============================================================================
// NAMESPACE CONSTANTS - LEGACY (0.3.0 / Conversations / Gajim)
// =============================================================================

/** Legacy OMEMO namespace (0.3.0 for Conversations/Gajim compatibility) */
export const NS_OMEMO_LEGACY = "eu.siacs.conversations.axolotl";

/** Legacy OMEMO device list PEP node */
export const NS_OMEMO_DEVICES_LEGACY = `${NS_OMEMO_LEGACY}.devicelist`;

/** Legacy OMEMO bundle PEP node prefix (append :<deviceId>) */
export const NS_OMEMO_BUNDLES_LEGACY = `${NS_OMEMO_LEGACY}.bundles`;

// =============================================================================
// NAMESPACE CONSTANTS - OMEMO 2.0 (XEP-0384 current)
// =============================================================================

/** OMEMO 2.0 namespace */
export const NS_OMEMO_V2 = "urn:xmpp:omemo:2";

/** OMEMO 2.0 device list PEP node */
export const NS_OMEMO_DEVICES_V2 = "urn:xmpp:omemo:2:devices";

/** OMEMO 2.0 bundle PEP node prefix (append :<deviceId>) */
export const NS_OMEMO_BUNDLES_V2 = "urn:xmpp:omemo:2:bundles";

// =============================================================================
// DEFAULT NAMESPACES (use legacy for publishing, accept both for receiving)
// =============================================================================

/** Primary OMEMO namespace for publishing (legacy for max compatibility) */
export const NS_OMEMO = NS_OMEMO_LEGACY;

/** Primary device list node for publishing */
export const NS_OMEMO_DEVICES = NS_OMEMO_DEVICES_LEGACY;

/** Primary bundle node prefix for publishing */
export const NS_OMEMO_BUNDLES = NS_OMEMO_BUNDLES_LEGACY;

/** All recognized OMEMO encrypted element namespaces */
export const OMEMO_NAMESPACES = [NS_OMEMO_LEGACY, NS_OMEMO_V2];

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * OMEMO device entry
 */
export interface OmemoDevice {
  /** Device ID (31-bit unsigned integer) */
  id: number;
  /** Optional device label */
  label?: string;
}

/**
 * OMEMO key bundle published via PEP
 */
export interface OmemoBundle {
  /** Identity public key (Curve25519) */
  identityKey: Uint8Array;
  /** Signed pre-key */
  signedPreKey: {
    id: number;
    publicKey: Uint8Array;
    signature: Uint8Array;
  };
  /** One-time pre-keys */
  preKeys: Array<{
    id: number;
    publicKey: Uint8Array;
  }>;
}

/**
 * OMEMO encrypted message key for a recipient device
 */
export interface OmemoMessageKey {
  /** Recipient device ID */
  deviceId: number;
  /** Encrypted message key (Signal protocol encrypted) */
  encryptedKey: Uint8Array;
  /** Whether this is a pre-key message (first message to device) */
  isPreKeyMessage: boolean;
}

/**
 * OMEMO encrypted message structure
 */
export interface OmemoEncryptedMessage {
  /** Sender device ID */
  senderDeviceId: number;
  /** Encrypted keys for recipient devices */
  keys: OmemoMessageKey[];
  /** Initialization vector */
  iv: Uint8Array;
  /** AES-GCM encrypted payload */
  payload: Uint8Array;
}

/**
 * Signal protocol session identifier
 */
export interface SessionIdentifier {
  /** Bare JID of the contact */
  jid: string;
  /** Device ID */
  deviceId: number;
}

/**
 * Stored key pair
 */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Stored signed pre-key with signature
 */
export interface SignedPreKey {
  id: number;
  keyPair: KeyPair;
  signature: Uint8Array;
  timestamp: number;
}

/**
 * OMEMO store persistence data
 */
export interface OmemoStoreData {
  /** Device ID */
  deviceId: number;
  /** Registration ID */
  registrationId: number;
  /** Identity key pair (base64 encoded) */
  identityKeyPair: {
    publicKey: string;
    privateKey: string;
  };
  /** Signed pre-key (base64 encoded) */
  signedPreKey: {
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    timestamp: number;
  };
  /** Pre-keys (base64 encoded) */
  preKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
  }>;
  /** Sessions (base64 encoded) */
  sessions: Record<string, string>;
  /** Known identities (base64 encoded) */
  identities: Record<string, string>;
}
