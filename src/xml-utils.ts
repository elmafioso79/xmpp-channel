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
  if (!el?.children) {return "";}
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
  if (!error) {return "Unknown error";}
  const text = error.getChildText("text");
  if (text) {return text;}
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

/** Plugin version - must be updated manually when package.json version changes */
 
export const PLUGIN_VERSION: string = "0.4.0";

/**
 * Get the plugin version.
 * Version is embedded at build time to avoid JSON import issues.
 */
export async function getPluginVersion(): Promise<string> {
  return PLUGIN_VERSION;
}

/** Plugin display name */
export const PLUGIN_NAME = "OpenClaw XMPP";

/** Runtime OS description */
export const PLUGIN_OS =
  typeof process !== "undefined" ? `Node.js ${process.version}` : "Unknown";
