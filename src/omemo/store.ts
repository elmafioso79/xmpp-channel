/**
 * OMEMO Signal Protocol Store
 * 
 * Implements the Signal protocol storage interface with ALWAYS-TRUST policy.
 * The bot blindly trusts all identity keys - no user verification required.
 */

// Note: libsignal-protocol-typescript types are loaded dynamically
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SignalLib = any;

import type { Logger } from "../types.js";
import { toBase64, fromBase64 } from "../xml-utils.js";
import type { KeyPair, SignedPreKey, OmemoStoreData } from "./types.js";

// toBase64, fromBase64 imported from xml-utils.ts

/**
 * Convert Uint8Array to ArrayBuffer (proper type conversion)
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Generate session key from JID and device ID
 * Uses '.' as separator to match Signal library's SignalProtocolAddress.toString()
 */
function sessionKey(jid: string, deviceId: number): string {
  return `${jid}.${deviceId}`;
}

// =============================================================================
// SIGNAL LIBRARY LOADING
// =============================================================================

let signalLib: SignalLib = null;
let signalLoaded = false;
let signalLoadError: Error | null = null;

/**
 * Load the Signal protocol library dynamically
 */
async function loadSignalLib(): Promise<SignalLib> {
  if (signalLoaded) {
    if (signalLoadError) throw signalLoadError;
    return signalLib;
  }
  
  try {
    signalLib = await import("@privacyresearch/libsignal-protocol-typescript");
    signalLoaded = true;
    return signalLib;
  } catch (err) {
    signalLoadError = err instanceof Error ? err : new Error(String(err));
    signalLoaded = true;
    throw signalLoadError;
  }
}

// =============================================================================
// OMEMO STORE CLASS
// =============================================================================

/**
 * Signal protocol store with ALWAYS-TRUST policy
 * 
 * This store blindly trusts all identity keys - appropriate for a bot
 * that accepts encryption from any user.
 */
export class OmemoStore {
  private accountId: string;
  private log?: Logger;
  private selfJid: string = ""; // Our actual JID (e.g., aurora@sazsxm.com)

  // Identity
  private deviceId: number = 0;
  private registrationId: number = 0;
  private identityKeyPair: KeyPair | null = null;

  // Pre-keys
  private preKeys = new Map<number, KeyPair>();
  private signedPreKey: SignedPreKey | null = null;

  // Sessions and identities
  // Note: Signal library may store sessions as JSON strings OR ArrayBuffers depending on implementation
  private sessions = new Map<string, string | ArrayBuffer>();
  private identities = new Map<string, ArrayBuffer>();

  // Persistence callback
  private persistCallback?: () => Promise<void>;
  
  // Signal library reference
  private signal: SignalLib = null;

  constructor(accountId: string, log?: Logger) {
    this.accountId = accountId;
    this.log = log;
  }

  /**
   * Set the self JID (used for encrypting to self)
   */
  setSelfJid(jid: string): void {
    this.selfJid = jid;
  }

  /**
   * Get the self JID
   */
  getSelfJid(): string {
    return this.selfJid;
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the store - generate new keys or load existing
   */
  async initialize(existingData?: OmemoStoreData): Promise<void> {
    // Load Signal library
    this.signal = await loadSignalLib();
    
    if (existingData) {
      await this.loadFromData(existingData);
      this.log?.info?.(`[${this.accountId}] OMEMO loaded device ${this.deviceId}`);
    } else {
      await this.generateIdentity();
      this.log?.info?.(`[${this.accountId}] OMEMO generated device ${this.deviceId}`);
    }
  }

  /**
   * Load store from persisted data
   */
  private async loadFromData(data: OmemoStoreData): Promise<void> {
    this.deviceId = data.deviceId;
    this.registrationId = data.registrationId;

    this.identityKeyPair = {
      publicKey: fromBase64(data.identityKeyPair.publicKey),
      privateKey: fromBase64(data.identityKeyPair.privateKey),
    };

    this.signedPreKey = {
      id: data.signedPreKey.id,
      keyPair: {
        publicKey: fromBase64(data.signedPreKey.publicKey),
        privateKey: fromBase64(data.signedPreKey.privateKey),
      },
      signature: fromBase64(data.signedPreKey.signature),
      timestamp: data.signedPreKey.timestamp,
    };

    this.preKeys.clear();
    for (const pk of data.preKeys) {
      this.preKeys.set(pk.id, {
        publicKey: fromBase64(pk.publicKey),
        privateKey: fromBase64(pk.privateKey),
      });
    }

    this.sessions.clear();
    for (const [key, value] of Object.entries(data.sessions)) {
      // Skip empty sessions (corrupted data)
      if (!value || value.length === 0) {
        continue;
      }
      // Check if it's a JSON string session (starts with '{')
      // or base64-encoded ArrayBuffer
      if (value.startsWith('{')) {
        // JSON string session - store as-is
        this.sessions.set(key, value);
      } else {
        // Base64-encoded ArrayBuffer
        this.sessions.set(key, toArrayBuffer(fromBase64(value)));
      }
    }

    this.identities.clear();
    for (const [key, value] of Object.entries(data.identities)) {
      this.identities.set(key, toArrayBuffer(fromBase64(value)));
    }
  }

  /**
   * Generate new identity and keys
   */
  private async generateIdentity(): Promise<void> {
    const { KeyHelper } = this.signal;
    
    // Generate device ID (31-bit unsigned integer)
    this.deviceId = Math.floor(Math.random() * 0x7FFFFFFF);
    
    // Generate registration ID
    this.registrationId = KeyHelper.generateRegistrationId();

    // Generate identity key pair
    const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
    this.identityKeyPair = {
      publicKey: new Uint8Array(identityKeyPair.pubKey),
      privateKey: new Uint8Array(identityKeyPair.privKey),
    };

    // Generate signed pre-key
    const signedPreKeyId = Math.floor(Math.random() * 0xFFFFFF);
    const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId);
    this.signedPreKey = {
      id: signedPreKey.keyId,
      keyPair: {
        publicKey: new Uint8Array(signedPreKey.keyPair.pubKey),
        privateKey: new Uint8Array(signedPreKey.keyPair.privKey),
      },
      signature: new Uint8Array(signedPreKey.signature),
      timestamp: Date.now(),
    };

    // Generate pre-keys
    await this.generatePreKeys(100);
  }

  /**
   * Generate one-time pre-keys
   */
  async generatePreKeys(count: number = 100): Promise<void> {
    const { KeyHelper } = this.signal;
    const startId = Math.floor(Math.random() * 0xFFFFFF);

    // Generate pre-keys one at a time (library only has generatePreKey singular)
    for (let i = 0; i < count; i++) {
      const keyId = startId + i;
      const pk = await KeyHelper.generatePreKey(keyId);
      this.preKeys.set(pk.keyId, {
        publicKey: new Uint8Array(pk.keyPair.pubKey),
        privateKey: new Uint8Array(pk.keyPair.privKey),
      });
    }

    await this.persist();
  }

  // ===========================================================================
  // PERSISTENCE
  // ===========================================================================

  /**
   * Set persistence callback
   */
  setPersistCallback(callback: () => Promise<void>): void {
    this.persistCallback = callback;
  }

  /**
   * Persist store data
   */
  private async persist(): Promise<void> {
    if (this.persistCallback) {
      await this.persistCallback();
    }
  }

  /**
   * Export store data for persistence
   */
  exportData(): OmemoStoreData {
    if (!this.identityKeyPair || !this.signedPreKey) {
      throw new Error("OMEMO store not initialized");
    }

    const preKeys: OmemoStoreData["preKeys"] = [];
    for (const [id, keyPair] of this.preKeys) {
      preKeys.push({
        id,
        publicKey: toBase64(keyPair.publicKey),
        privateKey: toBase64(keyPair.privateKey),
      });
    }

    const sessions: Record<string, string> = {};
    for (const [key, value] of this.sessions) {
      if (!value) {
        this.log?.warn?.(`[OMEMO] Empty session for ${key}, skipping`);
        continue;
      }
      // Handle string sessions (JSON)
      if (typeof value === 'string') {
        if (value.length > 0) {
          sessions[key] = value;
        } else {
          this.log?.warn?.(`[OMEMO] Empty string session for ${key}, skipping`);
        }
      } else if (value.byteLength > 0) {
        // Handle ArrayBuffer sessions - convert to base64
        sessions[key] = toBase64(new Uint8Array(value));
      } else {
        this.log?.warn?.(`[OMEMO] Empty buffer session for ${key}, skipping`);
      }
    }

    const identities: Record<string, string> = {};
    for (const [key, value] of this.identities) {
      identities[key] = toBase64(new Uint8Array(value));
    }

    return {
      deviceId: this.deviceId,
      registrationId: this.registrationId,
      identityKeyPair: {
        publicKey: toBase64(this.identityKeyPair.publicKey),
        privateKey: toBase64(this.identityKeyPair.privateKey),
      },
      signedPreKey: {
        id: this.signedPreKey.id,
        publicKey: toBase64(this.signedPreKey.keyPair.publicKey),
        privateKey: toBase64(this.signedPreKey.keyPair.privateKey),
        signature: toBase64(this.signedPreKey.signature),
        timestamp: this.signedPreKey.timestamp,
      },
      preKeys,
      sessions,
      identities,
    };
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  getDeviceId(): number {
    return this.deviceId;
  }

  getRegistrationIdSync(): number {
    return this.registrationId;
  }

  getIdentityKeyPairSync(): KeyPair {
    if (!this.identityKeyPair) {
      throw new Error("OMEMO store not initialized");
    }
    return this.identityKeyPair;
  }

  getSignedPreKey(): SignedPreKey | null {
    return this.signedPreKey;
  }

  getPreKeys(): Array<{ id: number; publicKey: Uint8Array }> {
    return Array.from(this.preKeys.entries()).map(([id, kp]) => ({
      id,
      publicKey: kp.publicKey,
    }));
  }

  // ===========================================================================
  // STORAGE TYPE INTERFACE (Signal Protocol)
  // ===========================================================================

  /**
   * Get direction enum (required by interface but unused)
   */
  Direction = {
    SENDING: 1,
    RECEIVING: 2,
  };

  /**
   * Get identity key pair (async - Signal interface)
   */
  async getIdentityKeyPair(): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer }> {
    if (!this.identityKeyPair) {
      throw new Error("OMEMO store not initialized");
    }
    return {
      pubKey: toArrayBuffer(this.identityKeyPair.publicKey),
      privKey: toArrayBuffer(this.identityKeyPair.privateKey),
    };
  }

  /**
   * Get local registration ID
   */
  async getLocalRegistrationId(): Promise<number> {
    return this.registrationId;
  }

  /**
   * Check if identity is trusted - ALWAYS TRUE (blind trust)
   */
  async isTrustedIdentity(
    _identifier: string,
    _identityKey: ArrayBuffer,
    _direction: number
  ): Promise<boolean> {
    // ALWAYS TRUST - bot accepts any identity key
    return true;
  }

  /**
   * Save identity key for a contact
   */
  async saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
    const existing = this.identities.get(identifier);
    this.identities.set(identifier, identityKey);
    await this.persist();

    // Return true if key changed
    if (existing) {
      const existingArr = new Uint8Array(existing);
      const newArr = new Uint8Array(identityKey);
      if (existingArr.length !== newArr.length) return true;
      for (let i = 0; i < existingArr.length; i++) {
        if (existingArr[i] !== newArr[i]) return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Load pre-key
   */
  async loadPreKey(keyId: number): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer } | undefined> {
    const key = this.preKeys.get(keyId);
    if (!key) return undefined;
    return {
      pubKey: toArrayBuffer(key.publicKey),
      privKey: toArrayBuffer(key.privateKey),
    };
  }

  /**
   * Store pre-key
   */
  async storePreKey(keyId: number, keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }): Promise<void> {
    this.preKeys.set(keyId, {
      publicKey: new Uint8Array(keyPair.pubKey),
      privateKey: new Uint8Array(keyPair.privKey),
    });
    await this.persist();
  }

  /**
   * Remove pre-key (after use)
   */
  async removePreKey(keyId: number): Promise<void> {
    this.preKeys.delete(keyId);
    await this.persist();

    // Regenerate if running low on pre-keys
    if (this.preKeys.size < 20) {
      this.log?.info?.(`[${this.accountId}] OMEMO regenerating pre-keys (${this.preKeys.size} remaining)`);
      await this.generatePreKeys(100);
    }
  }

  /**
   * Load signed pre-key
   */
  async loadSignedPreKey(keyId: number): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer } | undefined> {
    if (!this.signedPreKey || this.signedPreKey.id !== keyId) {
      return undefined;
    }
    return {
      pubKey: toArrayBuffer(this.signedPreKey.keyPair.publicKey),
      privKey: toArrayBuffer(this.signedPreKey.keyPair.privateKey),
    };
  }

  /**
   * Store signed pre-key
   */
  async storeSignedPreKey(
    keyId: number,
    keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }
  ): Promise<void> {
    // Note: signature is generated at creation time, not stored separately
    this.signedPreKey = {
      id: keyId,
      keyPair: {
        publicKey: new Uint8Array(keyPair.pubKey),
        privateKey: new Uint8Array(keyPair.privKey),
      },
      signature: this.signedPreKey?.signature ?? new Uint8Array(0),
      timestamp: Date.now(),
    };
    await this.persist();
  }

  /**
   * Remove signed pre-key
   */
  async removeSignedPreKey(_keyId: number): Promise<void> {
    // Don't remove - we need at least one signed pre-key
  }

  /**
   * Load session
   * 
   * Returns the session record as stored - may be string or ArrayBuffer
   * depending on how the Signal library serializes sessions.
   */
  async loadSession(identifier: string): Promise<string | ArrayBuffer | undefined> {
    const session = this.sessions.get(identifier);
    // Return undefined for empty sessions to force new session creation
    if (!session) {
      return undefined;
    }
    // Handle string sessions
    if (typeof session === 'string') {
      if (session.length === 0) {
        return undefined;
      }
      return session;
    }
    // Handle ArrayBuffer sessions
    if (session.byteLength === 0) {
      return undefined;
    }
    return session;
  }

  /**
   * Store session
   * 
   * Signal library from @privacyresearch/libsignal-protocol-typescript
   * serializes sessions as JSON strings, not ArrayBuffers.
   * Note: The library may return String objects (boxed) instead of primitive strings.
   */
  async storeSession(identifier: string, record: string | ArrayBuffer): Promise<void> {
    // Guard against undefined/null records
    if (record === undefined || record === null) {
      this.log?.warn?.(`[OMEMO] storeSession ${identifier}: ignoring undefined/null record`);
      return;
    }
    
    // Handle string records (JSON serialized sessions)
    // Check for both primitive strings AND String objects (boxed strings)
    // typeof "str" === 'string', but typeof new String("str") === 'object'
    const isStringType = typeof record === 'string' || record instanceof String;
    if (isStringType) {
      const strRecord = String(record);  // Convert to primitive string
      if (strRecord.length === 0) {
        this.log?.warn?.(`[OMEMO] storeSession ${identifier}: ignoring empty string record`);
        return;
      }
      this.sessions.set(identifier, strRecord);
      await this.persist();
      return;
    }
    
    // Handle ArrayBuffer records
    const recordType = Object.prototype.toString.call(record);
    
    let buf: ArrayBuffer;
    
    if (record instanceof ArrayBuffer && typeof record.byteLength === 'number') {
      buf = record;
    } else if (ArrayBuffer.isView(record)) {
      const view = record as unknown as Uint8Array;
      buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    } else if (typeof (record as any).byteLength === 'number') {
      try {
        const len = (record as any).byteLength;
        buf = new ArrayBuffer(len);
        new Uint8Array(buf).set(new Uint8Array(record as ArrayBuffer));
      } catch (e) {
        this.log?.warn?.(`[OMEMO] storeSession ${identifier}: failed to copy record - ${e}`);
        return;
      }
    } else {
      this.log?.warn?.(`[OMEMO] storeSession ${identifier}: unexpected record type ${typeof record} (${recordType})`);
      return;
    }
    
    if (!buf || buf.byteLength === 0) {
      this.log?.warn?.(`[OMEMO] storeSession ${identifier}: ignoring empty buffer`);
      return;
    }
    
    this.sessions.set(identifier, buf);
    await this.persist();
  }

  /**
   * Remove session
   */
  async removeSession(identifier: string): Promise<void> {
    this.sessions.delete(identifier);
    await this.persist();
  }

  /**
   * Remove all sessions for a recipient
   */
  async removeAllSessions(identifier: string): Promise<void> {
    const prefix = identifier.split(":")[0] + ":";
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix)) {
        this.sessions.delete(key);
      }
    }
    await this.persist();
  }

  // ===========================================================================
  // SESSION HELPERS
  // ===========================================================================

  /**
   * Check if we have a session with a device
   */
  hasSession(jid: string, deviceId: number): boolean {
    return this.sessions.has(sessionKey(jid, deviceId));
  }

  /**
   * Create session builder for establishing new sessions
   */
  createSessionBuilder(jid: string, deviceId: number): SignalLib {
    const { SignalProtocolAddress, SessionBuilder } = this.signal;
    const address = new SignalProtocolAddress(jid, deviceId);
    return new SessionBuilder(this, address);
  }

  /**
   * Create session cipher for encrypt/decrypt
   */
  createSessionCipher(jid: string, deviceId: number): SignalLib {
    const { SignalProtocolAddress, SessionCipher } = this.signal;
    const address = new SignalProtocolAddress(jid, deviceId);
    return new SessionCipher(this, address);
  }
}
