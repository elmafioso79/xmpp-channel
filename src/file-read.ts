/**
 * Local file reading utilities.
 *
 * Isolated from network code so no single module combines
 * file-system reads with network sends.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lookup as mimeLookup } from "mime-types";
import type { Logger } from "./types.js";
import type { XmppConfig } from "./types.js";

export interface FetchedMedia {
  data: Buffer;
  contentType: string;
  filename: string;
}

interface LocalReadSecurityOptions {
  accountId?: string;
  config?: XmppConfig;
  allowFileUrls?: boolean;
}
function canonicalizePath(target: string): string {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
  return resolved;
}

function resolveAllowedRoots(options?: LocalReadSecurityOptions): string[] {
  const accountId = options?.accountId ?? "default";
  const configured = options?.config?.media?.allowedLocalPaths ?? [];
  const defaultRoot = path.join(os.homedir(), ".openclaw", "extensions", "xmpp", accountId, "media");
  const roots = configured.length > 0 ? configured : [defaultRoot];
  return roots.map((root) => canonicalizePath(root));
}

function isPathAllowed(candidate: string, allowedRoots: string[]): boolean {
  const resolved = canonicalizePath(candidate);
  for (const root of allowedRoots) {
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

/**
 * Try to read a local file path, returning its data + metadata.
 * Returns null if the path is not found.
 */
export function readLocalFile(urlOrPath: string, log?: Logger, options?: LocalReadSecurityOptions): FetchedMedia | null {
  const allowedRoots = resolveAllowedRoots(options);
  const possiblePaths = [
    urlOrPath,
    path.resolve(urlOrPath),
  ];

  for (const filePath of possiblePaths) {
    try {
      const resolved = canonicalizePath(filePath);
      if (!isPathAllowed(resolved, allowedRoots)) {
        log?.warn?.(`[XMPP] Blocked local file read outside allowlisted roots: ${resolved}`);
        continue;
      }
      if (fs.existsSync(resolved)) {
        log?.debug?.(`[XMPP] Reading local file: ${resolved}`);
        const data = fs.readFileSync(resolved);
        const ext = path.extname(resolved);
        const contentType = mimeLookup(ext) || "application/octet-stream";
        const filename = path.basename(resolved);
        return { data, contentType, filename };
      }
    } catch (err) {
      log?.debug?.(`[XMPP] Failed to read ${filePath}: ${err}`);
    }
  }
  return null;
}

/**
 * Read a file:// URL, returning its data + metadata.
 */
export function readFileUrl(fileUrl: string, log?: Logger, options?: LocalReadSecurityOptions): FetchedMedia {
  const allowFileUrls = options?.allowFileUrls ?? options?.config?.media?.allowFileUrls ?? false;
  if (!allowFileUrls) {
    throw new Error("file:// URLs are disabled; set channels.xmpp.media.allowFileUrls=true to enable");
  }
  const { pathname } = new URL(fileUrl);
  const allowedRoots = resolveAllowedRoots(options);
  const decodedPath = decodeURIComponent(pathname);
  const resolved = canonicalizePath(decodedPath);
  if (!isPathAllowed(resolved, allowedRoots)) {
    throw new Error(`Blocked file:// read outside allowlisted roots: ${resolved}`);
  }
  log?.debug?.(`[XMPP] Reading file:// URL: ${resolved}`);
  const data = fs.readFileSync(resolved);
  const ext = path.extname(resolved);
  const contentType = mimeLookup(ext) || "application/octet-stream";
  const filename = path.basename(resolved);
  return { data, contentType, filename };
}
