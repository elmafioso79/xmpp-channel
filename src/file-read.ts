/**
 * Local file reading utilities.
 *
 * Isolated from network code so no single module combines
 * file-system reads with network sends.
 */

import * as fs from "fs";
import * as path from "path";
import { lookup as mimeLookup } from "mime-types";
import type { Logger } from "./types.js";

export interface FetchedMedia {
  data: Buffer;
  contentType: string;
  filename: string;
}

/**
 * Try to read a local file path, returning its data + metadata.
 * Returns null if the path is not found.
 */
export function readLocalFile(urlOrPath: string, log?: Logger): FetchedMedia | null {
  const possiblePaths = [
    urlOrPath,
    path.resolve(urlOrPath),
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
  return null;
}

/**
 * Read a file:// URL, returning its data + metadata.
 */
export function readFileUrl(fileUrl: string, log?: Logger): FetchedMedia {
  const { pathname } = new URL(fileUrl);
  log?.debug?.(`[XMPP] Reading file:// URL: ${pathname}`);
  const data = fs.readFileSync(pathname);
  const ext = path.extname(pathname);
  const contentType = mimeLookup(ext) || "application/octet-stream";
  const filename = path.basename(pathname);
  return { data, contentType, filename };
}
