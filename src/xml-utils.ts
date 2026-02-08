/**
 * Shared XML / crypto utility functions
 *
 * Centralises helpers that were previously duplicated across
 * pep.ts, http-upload.ts, omemo/index.ts, omemo/bundle.ts and omemo/store.ts.
 */

import type { Element } from "@xmpp/client";

// =============================================================================
// BASE64 / BINARY HELPERS
// =============================================================================

/**
 * Convert Uint8Array to base64 string
 */
export function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/**
 * Convert base64 string to Uint8Array
 */
export function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

// =============================================================================
// XML ELEMENT HELPERS
// =============================================================================

/**
 * Get text content from an Element (handles xmpp.js Element structure)
 */
export function getElementText(el: Element): string {
  if (!el || !el.children) return "";
  for (const child of el.children) {
    if (typeof child === "string") {
      return child;
    }
  }
  return "";
}

/**
 * Extract human-readable error text from an IQ error element
 */
export function extractErrorText(error: Element | undefined): string {
  if (!error) return "Unknown error";
  const text = error.getChildText("text");
  if (text) return text;
  // Try to get first child element's name as error type
  const children = error.children || [];
  for (const child of children) {
    if (typeof child !== "string" && (child as Element).name) {
      return (child as Element).name;
    }
  }
  return "Unknown error";
}

// =============================================================================
// IQ HELPERS
// =============================================================================

/**
 * Create a unique IQ ID with an optional prefix for traceability
 */
export function iqId(prefix: string = "iq"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wait for an IQ response matching the given request ID
 */
export function waitForIq(
  client: ReturnType<typeof import("@xmpp/client").client>,
  requestId: string,
  timeoutMs: number = 30000
): Promise<Element> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("IQ request timed out"));
    }, timeoutMs);

    const handler = (stanza: Element) => {
      if (stanza.is("iq") && stanza.attrs.id === requestId) {
        cleanup();
        resolve(stanza);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      client.off("stanza", handler);
    };

    client.on("stanza", handler);
  });
}

// =============================================================================
// PLUGIN META
// =============================================================================

/**
 * Read the plugin version from package.json at build time.
 *
 * Falls back to "unknown" if the import somehow fails at runtime
 * (e.g. when running from a bundled context that strips JSON imports).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pkg: { version: string } | null = null;

async function loadPkg(): Promise<{ version: string }> {
  if (_pkg) return _pkg;
  try {
    // Dynamic import so the path is resolved relative to compiled output
    const mod = await import("../package.json", { assert: { type: "json" } });
    _pkg = mod.default ?? mod;
    return _pkg!;
  } catch {
    _pkg = { version: "unknown" };
    return _pkg;
  }
}

/** Cached plugin version string */
let _pluginVersion: string | null = null;

/**
 * Get the plugin version (reads from package.json on first call, then caches)
 */
export async function getPluginVersion(): Promise<string> {
  if (_pluginVersion) return _pluginVersion;
  const pkg = await loadPkg();
  _pluginVersion = pkg.version;
  return _pluginVersion;
}

/** Plugin display name */
export const PLUGIN_NAME = "OpenClaw XMPP";

/** Runtime OS description */
export const PLUGIN_OS =
  typeof process !== "undefined" ? `Node.js ${process.version}` : "Unknown";
