import { xml } from "@xmpp/client";
import type { XmppConfig, SendResult, Logger } from "./types.js";
import { getActiveClient } from "./monitor.js";
import { bareJid, resolveServer } from "./config-schema.js";
import { getUploadService, uploadAndGetUrl, buildOobElement, downloadUrl } from "./http-upload.js";
import { isOmemoEnabled, encryptOmemoMessage, encryptMucOmemoMessage, buildOmemoMessageStanza, isRoomOmemoCapable } from "./omemo/index.js";
import { sentMessageIds } from "./state.js";

export interface ResolvedMedia {
  data: Buffer;
  contentType: string;
  filename: string;
}

/**
 * Send a text message via XMPP
 * When OMEMO is enabled, always encrypts. On encryption failure, sends
 * an unencrypted warning (never the actual message content).
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
    // Determine if this is a group room or direct message
    const isMuc = config.groups?.some((room) => bareJid(room) === bareJid(to));
    const msgType = isMuc ? "groupchat" : "chat";

    // When OMEMO is enabled, always encrypt outbound messages
    if (isOmemoEnabled(accountId)) {
      try {
        const encryptedElement = isMuc
          ? await encryptMucOmemoMessage(accountId, bareJid(to), text, log)
          : await encryptOmemoMessage(accountId, bareJid(to), text, log);

        if (encryptedElement) {
          const encryptedStanza = buildOmemoMessageStanza(to, encryptedElement, msgType);
          await client.send(encryptedStanza);
          log?.debug?.(`[XMPP] Sent OMEMO encrypted message to ${to}`);
          return { ok: true, messageId: encryptedStanza.attrs.id };
        }

        // Encryption returned null — send warning, not the actual text
        log?.warn?.(`[XMPP] OMEMO encryption returned empty for ${to}, sending warning`);
        const warnMsg = xml(
          "message",
          { to, type: msgType, id: `msg_${Date.now()}` },
          xml("body", {}, "⚠️ Failed to encrypt message (OMEMO encryption returned empty). Message not sent for security.")
        );
        await client.send(warnMsg);
        return { ok: false, error: "OMEMO encryption failed (returned empty)" };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log?.error?.(`[XMPP] OMEMO encryption error for ${to}: ${errMsg}, sending warning`);
        const warnMsg = xml(
          "message",
          { to, type: msgType, id: `msg_${Date.now()}` },
          xml("body", {}, `⚠️ Failed to encrypt message: ${errMsg}. Message not sent for security.`)
        );
        await client.send(warnMsg);
        return { ok: false, error: `OMEMO encryption failed: ${errMsg}` };
      }
    }

    // OMEMO not enabled — send plaintext
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
 * Send a media message via XMPP
 * If HTTP Upload is available, uploads the file and sends the URL
 * Otherwise, sends the URL as plain text
 */
export async function sendXmppMedia(
  config: XmppConfig,
  to: string,
  mediaUrl: string,
  caption?: string,
  options: { log?: Logger; accountId?: string; resolvedMedia?: ResolvedMedia } = {}
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
    const isMuc = config.groups?.some((room) => bareJid(room) === bareJid(to));
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
        // Use pre-resolved media data or download from HTTP URL
        log?.debug?.(`[XMPP] Fetching: ${mediaUrl}`);
        const mediaData = options.resolvedMedia ?? await downloadUrl(mediaUrl, log);
        const { data, contentType, filename } = mediaData;

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

    // When OMEMO is enabled, encrypt all outbound messages including media URLs
    if (isOmemoEnabled(accountId)) {
      const encryptFn = isMuc
        ? (text: string) => encryptMucOmemoMessage(accountId, bareJid(to), text, log)
        : (text: string) => encryptOmemoMessage(accountId, bareJid(to), text, log);

      try {
        // Send encrypted caption first if present
        if (caption && caption.trim()) {
          const captionEnc = await encryptFn(caption);
          if (captionEnc) {
            const captionStanza = buildOmemoMessageStanza(to, captionEnc, msgType);
            await client.send(captionStanza);
          } else {
            log?.warn?.(`[XMPP] OMEMO caption encryption returned empty`);
          }
        }

        // Send encrypted URL
        const urlEnc = await encryptFn(shareUrl);
        if (urlEnc) {
          const urlStanza = buildOmemoMessageStanza(to, urlEnc, msgType);
          await client.send(urlStanza);
          log?.info?.(`[XMPP] OMEMO encrypted media sent to ${to}`);
          return { ok: true, messageId: urlStanza.attrs.id };
        }

        // Encryption returned null — send warning, not the actual content
        log?.warn?.(`[XMPP] OMEMO encryption returned empty for media to ${to}, sending warning`);
        const warnMsg = xml(
          "message",
          { to, type: msgType, id: `msg_${Date.now()}` },
          xml("body", {}, "⚠️ Failed to encrypt media message (OMEMO encryption returned empty). Message not sent for security.")
        );
        await client.send(warnMsg);
        return { ok: false, error: "OMEMO encryption failed for media (returned empty)" };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log?.error?.(`[XMPP] OMEMO encryption error for media to ${to}: ${errMsg}`);
        const warnMsg = xml(
          "message",
          { to, type: msgType, id: `msg_${Date.now()}` },
          xml("body", {}, `⚠️ Failed to encrypt media message: ${errMsg}. Message not sent for security.`)
        );
        await client.send(warnMsg);
        return { ok: false, error: `OMEMO encryption failed for media: ${errMsg}` };
      }
    }

    // OMEMO not enabled — send plaintext
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
