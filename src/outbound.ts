import { xml } from "@xmpp/client";
import type { XmppConfig, SendResult, Logger } from "./types.js";
import { getActiveClient } from "./monitor.js";
import { bareJid, resolveServer } from "./config-schema.js";
import { getUploadService, uploadAndGetUrl, buildOobElement } from "./http-upload.js";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import { lookup as mimeLookup } from "mime-types";

/**
 * Send a text message via XMPP
 */
export async function sendXmppMessage(
  config: XmppConfig,
  to: string,
  text: string,
  options: { log?: unknown; accountId?: string } = {}
): Promise<SendResult> {
  const log = options.log as Logger | undefined;
  const accountId = options.accountId ?? "default";

  const client = getActiveClient(accountId);
  if (!client) {
    return { ok: false, error: "XMPP client not connected" };
  }

  try {
    // Determine if this is a MUC or direct message
    const isMuc = config.mucs?.some((muc) => bareJid(muc) === bareJid(to));
    const msgType = isMuc ? "groupchat" : "chat";

    const messageId = `msg_${Date.now()}`;
    const message = xml(
      "message",
      { to, type: msgType, id: messageId },
      xml("body", {}, text)
    );

    await client.send(message);
    log?.debug?.(`[XMPP] Sent message to ${to}`);

    return { ok: true, messageId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[XMPP] Failed to send message: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Send presence update
 */
export async function sendPresence(
  accountId: string,
  options: {
    status?: string;
    show?: "away" | "chat" | "dnd" | "xa";
    log?: Logger;
  } = {}
): Promise<SendResult> {
  const client = getActiveClient(accountId);
  if (!client) {
    return { ok: false, error: "XMPP client not connected" };
  }

  try {
    const children = [];
    if (options.show) {
      children.push(xml("show", {}, options.show));
    }
    if (options.status) {
      children.push(xml("status", {}, options.status));
    }

    const presence = xml("presence", {}, ...children);
    await client.send(presence);
    options.log?.debug?.(`[XMPP] Sent presence update`);

    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    options.log?.error?.(`[XMPP] Failed to send presence: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Check if a string is a URL
 */
function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * Fetch data from a URL or read from local file
 */
async function fetchUrl(urlOrPath: string, log?: Logger): Promise<{ data: Buffer; contentType: string; filename: string }> {
  // Check if it's a local file path (not a URL)
  if (!isUrl(urlOrPath)) {
    // Try to resolve as a local file path
    log?.debug?.(`[XMPP] Treating as local file path: ${urlOrPath}`);
    
    // Try different possible paths
    const possiblePaths = [
      urlOrPath,
      path.resolve(urlOrPath),
      path.resolve(process.cwd(), urlOrPath),
    ];
    
    for (const filePath of possiblePaths) {
      try {
        if (fs.existsSync(filePath)) {
          log?.debug?.(`[XMPP] Reading local file: ${filePath}`);
          const data = fs.readFileSync(filePath);
          const ext = path.extname(filePath);
          const contentType = mimeLookup(ext) || "application/octet-stream";
          const filename = path.basename(filePath);
          return { data, contentType, filename };
        }
      } catch (err) {
        log?.debug?.(`[XMPP] Failed to read ${filePath}: ${err}`);
      }
    }
    
    throw new Error(`File not found: ${urlOrPath}`);
  }
  
  // Handle file:// URLs
  const urlObj = new URL(urlOrPath);
  if (urlObj.protocol === "file:") {
    const filePath = urlObj.pathname;
    log?.debug?.(`[XMPP] Reading file:// URL: ${filePath}`);
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const contentType = mimeLookup(ext) || "application/octet-stream";
    const filename = path.basename(filePath);
    return { data, contentType, filename };
  }
  
  // HTTP(S) fetch
  return new Promise((resolve, reject) => {
    const httpModule = urlObj.protocol === "https:" ? https : http;

    httpModule.get(urlOrPath, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchUrl(res.headers.location, log).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const contentType = res.headers["content-type"] || "application/octet-stream";
        const filename = getFilenameFromUrl(urlOrPath);
        resolve({ data: Buffer.concat(chunks), contentType, filename });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Extract filename from URL
 */
function getFilenameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop() || "file";
    return decodeURIComponent(filename);
  } catch {
    return "file";
  }
}

/**
 * Send a media message via XMPP
 * If HTTP Upload is available, uploads the file and sends the URL
 * Otherwise, sends the URL as plain text
 */
export async function sendXmppMedia(
  config: XmppConfig,
  to: string,
  mediaUrl: string,
  caption?: string,
  options: { log?: Logger; accountId?: string } = {}
): Promise<SendResult> {
  const log = options.log;
  const accountId = options.accountId ?? "default";

  log?.debug?.(`[XMPP] sendXmppMedia: to=${to}, mediaUrl=${mediaUrl}`);

  const client = getActiveClient(accountId);
  if (!client) {
    log?.error?.(`[XMPP] sendXmppMedia: client not connected for account ${accountId}`);
    return { ok: false, error: "XMPP client not connected" };
  }

  try {
    const isMuc = config.mucs?.some((muc) => bareJid(muc) === bareJid(to));
    const msgType = isMuc ? "groupchat" : "chat";
    const serverDomain = resolveServer(config);

    log?.debug?.(`[XMPP] Looking for upload service on ${serverDomain}`);

    // Try to use HTTP Upload if available (auto-discovered)
    const uploadService = await getUploadService(
      accountId,
      serverDomain,
      undefined, // Auto-discover upload service
      log
    );

    let shareUrl = mediaUrl;

    if (uploadService) {
      log?.debug?.(`[XMPP] HTTP Upload service: ${uploadService}`);

      try {
        // Fetch the media file
        log?.debug?.(`[XMPP] Fetching: ${mediaUrl}`);
        const { data, contentType, filename } = await fetchUrl(mediaUrl, log);

        log?.debug?.(`[XMPP] Fetched ${filename} (${data.length} bytes, ${contentType})`);

        // Upload via HTTP Upload
        const uploadResult = await uploadAndGetUrl(
          accountId,
          uploadService,
          filename,
          data,
          contentType,
          log
        );

        if (uploadResult.ok && uploadResult.url) {
          shareUrl = uploadResult.url;
          log?.debug?.(`[XMPP] Uploaded to ${shareUrl}`);
        } else {
          log?.warn?.(`[XMPP] HTTP Upload failed: ${uploadResult.error}, falling back to URL`);
        }
      } catch (err) {
        log?.error?.(`[XMPP] Failed to fetch/upload media: ${err instanceof Error ? err.message : String(err)}`);
        // Return error instead of silently falling back
        return { ok: false, error: `Failed to fetch media: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      log?.warn?.(`[XMPP] No HTTP Upload service available, cannot send media`);
      return { ok: false, error: "No HTTP Upload service available" };
    }

    // For XMPP clients to display media inline (Conversations, Dino, etc.),
    // the body must contain ONLY the URL - no additional text.
    // If there's a caption, send it as a separate message first.
    
    if (caption && caption.trim()) {
      log?.debug?.(`[XMPP] Sending caption as separate message: ${caption.slice(0, 50)}...`);
      const captionMessage = xml(
        "message",
        { to, type: msgType, id: `msg_${Date.now()}_caption` },
        xml("body", {}, caption)
      );
      await client.send(captionMessage);
    }

    // Build media message with body containing ONLY the URL and OOB data
    // This is critical for clients like Conversations to display inline
    const messageId = `msg_${Date.now()}`;
    const message = xml(
      "message",
      { to, type: msgType, id: messageId },
      xml("body", {}, shareUrl),
      buildOobElement(shareUrl)
    );

    await client.send(message);
    log?.info?.(`[XMPP] Media sent to ${to}`);

    return { ok: true, messageId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[XMPP] Failed to send media: ${error}`);
    return { ok: false, error };
  }
}
