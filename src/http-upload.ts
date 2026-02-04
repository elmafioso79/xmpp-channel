/**
 * XEP-0363: HTTP File Upload
 * 
 * Allows uploading files to a server via HTTP and sharing them via XMPP.
 * The server returns a PUT URL for upload and a GET URL to share.
 * 
 * Flow:
 * 1. Request upload slot from server via IQ
 * 2. Upload file to PUT URL with optional headers
 * 3. Share GET URL in message body or as out-of-band data
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import { getActiveClient } from "./monitor.js";
import type { Logger } from "./types.js";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

// XEP-0363 namespace
export const NS_HTTP_UPLOAD = "urn:xmpp:http:upload:0";
export const NS_HTTP_UPLOAD_OLD = "urn:xmpp:http:upload"; // Legacy namespace

// Out-of-band data namespace for sharing URLs
export const NS_OOB = "jabber:x:oob";

export interface UploadSlot {
  /** PUT URL for uploading the file */
  putUrl: string;
  /** GET URL to share with recipients */
  getUrl: string;
  /** Optional headers to include with PUT request */
  headers?: Record<string, string>;
}

export interface UploadResult {
  ok: boolean;
  error?: string;
  /** The GET URL to share */
  url?: string;
}

export interface HttpUploadConfig {
  /** The upload service JID (e.g., "upload.example.com") - auto-discovered if not set */
  uploadServiceJid?: string;
  /** Maximum file size in bytes (server may have its own limits) */
  maxFileSize?: number;
}

/**
 * Create a unique IQ ID
 */
function iqId(): string {
  return `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extract error text from an error element
 */
function extractErrorText(error: Element | undefined): string {
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

/**
 * Wait for IQ response matching the request ID
 */
function waitForIq(
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

/**
 * Discover HTTP Upload service via disco
 * Queries server features to find upload service JID
 */
export async function discoverUploadService(
  accountId: string,
  serverDomain: string,
  log?: Logger
): Promise<string | null> {
  const client = getActiveClient(accountId);
  if (!client) {
    log?.error?.("[HTTP Upload] Client not connected");
    return null;
  }

  try {
    const id = iqId();
    
    // Query server for items (services)
    const itemsIq = xml("iq", { type: "get", to: serverDomain, id },
      xml("query", { xmlns: "http://jabber.org/protocol/disco#items" })
    );

    const responsePromise = waitForIq(client, id);
    await client.send(itemsIq);
    const response = await responsePromise;

    if (response.attrs.type !== "result") {
      log?.debug?.("[HTTP Upload] Failed to query server items");
      return null;
    }

    const query = response.getChild("query", "http://jabber.org/protocol/disco#items");
    const items = query?.getChildren("item") || [];

    // Check each item for HTTP Upload feature
    for (const item of items) {
      const jid = item.attrs.jid;
      if (!jid) continue;

      const infoId = iqId();
      const infoIq = xml("iq", { type: "get", to: jid, id: infoId },
        xml("query", { xmlns: "http://jabber.org/protocol/disco#info" })
      );

      try {
        const infoPromise = waitForIq(client, infoId, 10000);
        await client.send(infoIq);
        const infoResponse = await infoPromise;

        if (infoResponse.attrs.type !== "result") continue;

        const infoQuery = infoResponse.getChild("query", "http://jabber.org/protocol/disco#info");
        const features = infoQuery?.getChildren("feature") || [];

        for (const feature of features) {
          const featureVar = feature.attrs.var;
          if (featureVar === NS_HTTP_UPLOAD || featureVar === NS_HTTP_UPLOAD_OLD) {
            log?.info?.(`[HTTP Upload] Discovered upload service: ${jid}`);
            return jid;
          }
        }
      } catch {
        // Service didn't respond, continue to next
        continue;
      }
    }

    // Try common subdomains
    const commonSubdomains = ["upload", "http-upload", "httpupload", "share"];
    for (const subdomain of commonSubdomains) {
      const candidateJid = `${subdomain}.${serverDomain}`;
      const infoId = iqId();
      const infoIq = xml("iq", { type: "get", to: candidateJid, id: infoId },
        xml("query", { xmlns: "http://jabber.org/protocol/disco#info" })
      );

      try {
        const infoPromise = waitForIq(client, infoId, 5000);
        await client.send(infoIq);
        const infoResponse = await infoPromise;

        if (infoResponse.attrs.type !== "result") continue;

        const infoQuery = infoResponse.getChild("query", "http://jabber.org/protocol/disco#info");
        const features = infoQuery?.getChildren("feature") || [];

        for (const feature of features) {
          const featureVar = feature.attrs.var;
          if (featureVar === NS_HTTP_UPLOAD || featureVar === NS_HTTP_UPLOAD_OLD) {
            log?.info?.(`[HTTP Upload] Found upload service at: ${candidateJid}`);
            return candidateJid;
          }
        }
      } catch {
        continue;
      }
    }

    log?.debug?.("[HTTP Upload] No upload service found");
    return null;
  } catch (err) {
    log?.error?.(`[HTTP Upload] Discovery error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Request an upload slot from the server
 * 
 * @param accountId - The XMPP account ID
 * @param uploadServiceJid - The HTTP Upload service JID
 * @param filename - The name of the file to upload
 * @param size - The size of the file in bytes
 * @param contentType - The MIME type of the file
 * @param log - Optional logger
 */
export async function requestUploadSlot(
  accountId: string,
  uploadServiceJid: string,
  filename: string,
  size: number,
  contentType: string,
  log?: Logger
): Promise<{ ok: boolean; error?: string; slot?: UploadSlot }> {
  const client = getActiveClient(accountId);
  if (!client) {
    return { ok: false, error: "XMPP client not connected" };
  }

  try {
    const id = iqId();
    
    // XEP-0363 request
    const iq = xml("iq", { type: "get", to: uploadServiceJid, id },
      xml("request", { xmlns: NS_HTTP_UPLOAD, filename, size: String(size), "content-type": contentType })
    );

    log?.debug?.(`[HTTP Upload] Requesting slot for ${filename} (${size} bytes)`);

    const responsePromise = waitForIq(client, id);
    await client.send(iq);
    const response = await responsePromise;

    if (response.attrs.type === "result") {
      const slot = response.getChild("slot", NS_HTTP_UPLOAD);
      if (!slot) {
        // Try legacy namespace
        const slotOld = response.getChild("slot", NS_HTTP_UPLOAD_OLD);
        if (!slotOld) {
          return { ok: false, error: "Invalid slot response" };
        }
        
        const putEl = slotOld.getChild("put");
        const getEl = slotOld.getChild("get");
        
        if (!putEl || !getEl) {
          return { ok: false, error: "Missing PUT/GET URLs" };
        }

        return {
          ok: true,
          slot: {
            putUrl: putEl.attrs.url || putEl.text(),
            getUrl: getEl.attrs.url || getEl.text(),
          },
        };
      }

      const putEl = slot.getChild("put");
      const getEl = slot.getChild("get");

      if (!putEl || !getEl) {
        return { ok: false, error: "Missing PUT/GET URLs" };
      }

      // Parse headers if present
      const headers: Record<string, string> = {};
      for (const header of putEl.getChildren("header")) {
        const name = header.attrs.name;
        const value = header.text();
        if (name && value) {
          headers[name] = value;
        }
      }

      log?.info?.(`[HTTP Upload] Got upload slot: PUT=${putEl.attrs.url}`);

      return {
        ok: true,
        slot: {
          putUrl: putEl.attrs.url,
          getUrl: getEl.attrs.url,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        },
      };
    } else {
      const error = response.getChild("error");
      let errorText = "Unknown error";
      
      // Check for file-too-large error
      const fileTooLarge = error?.getChild("file-too-large", NS_HTTP_UPLOAD);
      if (fileTooLarge) {
        const maxSizeEl = fileTooLarge.getChild("max-file-size");
        const maxSize = maxSizeEl?.text();
        errorText = maxSize ? `File too large (max: ${maxSize} bytes)` : "File too large";
      } else {
        errorText = extractErrorText(error);
      }

      log?.error?.(`[HTTP Upload] Slot request failed: ${errorText}`);
      return { ok: false, error: errorText };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[HTTP Upload] Slot request error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Upload a file to the HTTP Upload service
 * 
 * @param slot - The upload slot returned by requestUploadSlot
 * @param data - The file data as a Buffer
 * @param contentType - The MIME type of the file
 * @param log - Optional logger
 */
export async function uploadFile(
  slot: UploadSlot,
  data: Buffer,
  contentType: string,
  log?: Logger
): Promise<UploadResult> {
  return new Promise((resolve) => {
    try {
      const url = new URL(slot.putUrl);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const options: http.RequestOptions = {
        method: "PUT",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          "Content-Type": contentType,
          "Content-Length": data.length,
          ...slot.headers,
        },
      };

      log?.debug?.(`[HTTP Upload] Uploading to ${slot.putUrl}`);

      const req = httpModule.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          log?.info?.(`[HTTP Upload] Upload successful: ${slot.getUrl}`);
          resolve({ ok: true, url: slot.getUrl });
        } else {
          log?.error?.(`[HTTP Upload] Upload failed with status ${res.statusCode}`);
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        }
      });

      req.on("error", (err) => {
        log?.error?.(`[HTTP Upload] Upload error: ${err.message}`);
        resolve({ ok: false, error: err.message });
      });

      req.write(data);
      req.end();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log?.error?.(`[HTTP Upload] Upload exception: ${error}`);
      resolve({ ok: false, error });
    }
  });
}

/**
 * Upload a file and return the shareable URL
 * Combines slot request and file upload into one operation
 * 
 * @param accountId - The XMPP account ID
 * @param uploadServiceJid - The HTTP Upload service JID
 * @param filename - The name of the file
 * @param data - The file data as a Buffer
 * @param contentType - The MIME type of the file
 * @param log - Optional logger
 */
export async function uploadAndGetUrl(
  accountId: string,
  uploadServiceJid: string,
  filename: string,
  data: Buffer,
  contentType: string,
  log?: Logger
): Promise<UploadResult> {
  // Request slot
  const slotResult = await requestUploadSlot(
    accountId,
    uploadServiceJid,
    filename,
    data.length,
    contentType,
    log
  );

  if (!slotResult.ok || !slotResult.slot) {
    return { ok: false, error: slotResult.error || "Failed to get upload slot" };
  }

  // Upload file
  return uploadFile(slotResult.slot, data, contentType, log);
}

/**
 * Build an OOB (Out-of-Band) element for sharing a URL
 * Can be added to a message to indicate a file attachment
 */
export function buildOobElement(url: string, description?: string): Element {
  const children: Element[] = [xml("url", {}, url)];
  if (description) {
    children.push(xml("desc", {}, description));
  }
  return xml("x", { xmlns: NS_OOB }, ...children);
}

/**
 * Parse OOB data from a message stanza
 */
export function parseOobData(stanza: Element): { url: string; description?: string } | null {
  const oob = stanza.getChild("x", NS_OOB);
  if (!oob) return null;

  const url = oob.getChildText("url");
  if (!url) return null;

  return {
    url,
    description: oob.getChildText("desc") || undefined,
  };
}

// Cache discovered upload services
const uploadServiceCache = new Map<string, string>();

/**
 * Get or discover the HTTP Upload service for a domain
 */
export async function getUploadService(
  accountId: string,
  serverDomain: string,
  configuredService?: string,
  log?: Logger
): Promise<string | null> {
  // Use configured service if provided
  if (configuredService) {
    return configuredService;
  }

  // Check cache
  const cached = uploadServiceCache.get(serverDomain);
  if (cached) {
    return cached;
  }

  // Discover
  const discovered = await discoverUploadService(accountId, serverDomain, log);
  if (discovered) {
    uploadServiceCache.set(serverDomain, discovered);
  }

  return discovered;
}
