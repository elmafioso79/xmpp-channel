/**
 * XMPP IQ Handlers
 *
 * Handles IQ (Info/Query) stanzas for various XEPs:
 * - XEP-0092: Software Version
 * - XEP-0202: Entity Time
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";
import type { client } from "@xmpp/client";
import type { Logger } from "./types.js";
import { getPluginVersion, PLUGIN_NAME, PLUGIN_OS } from "./xml-utils.js";

// XEP namespaces
const NS_VERSION = "jabber:iq:version";
const NS_TIME = "urn:xmpp:time";

/**
 * Setup IQ stanza handlers on the XMPP client
 */
export function setupIqHandlers(
  xmpp: ReturnType<typeof client>,
  accountId: string,
  log?: Logger
): void {
  xmpp.on("stanza", async (stanza) => {
    if (!stanza.is("iq")) return;
    if (stanza.attrs.type !== "get") return;

    const from = stanza.attrs.from;
    const id = stanza.attrs.id;
    if (!from || !id) return;

    // XEP-0092: Software Version
    const versionQuery = stanza.getChild("query", NS_VERSION);
    if (versionQuery) {
      await handleVersionQuery(xmpp, from, id, accountId, log);
      return;
    }

    // XEP-0202: Entity Time
    const timeQuery = stanza.getChild("time", NS_TIME);
    if (timeQuery) {
      await handleTimeQuery(xmpp, from, id, accountId, log);
      return;
    }
  });
}

/**
 * Handle XEP-0092 Software Version query
 *
 * Request: <iq type="get"><query xmlns="jabber:iq:version"/></iq>
 * Response: <iq type="result"><query xmlns="jabber:iq:version">
 *             <name>...</name><version>...</version><os>...</os>
 *           </query></iq>
 */
async function handleVersionQuery(
  xmpp: ReturnType<typeof client>,
  from: string,
  id: string,
  accountId: string,
  log?: Logger
): Promise<void> {
  log?.debug?.(`[${accountId}] XEP-0092 version query from ${from}`);

  const pluginVersion = await getPluginVersion();

  const response = xml(
    "iq",
    { type: "result", to: from, id },
    xml(
      "query",
      { xmlns: NS_VERSION },
      xml("name", {}, PLUGIN_NAME),
      xml("version", {}, pluginVersion),
      xml("os", {}, PLUGIN_OS)
    )
  );

  await xmpp.send(response);
  log?.debug?.(`[${accountId}] XEP-0092 version response sent to ${from}`);
}

/**
 * Handle XEP-0202 Entity Time query
 *
 * Request: <iq type="get"><time xmlns="urn:xmpp:time"/></iq>
 * Response: <iq type="result"><time xmlns="urn:xmpp:time">
 *             <tzo>+00:00</tzo><utc>2026-02-08T12:00:00Z</utc>
 *           </time></iq>
 */
async function handleTimeQuery(
  xmpp: ReturnType<typeof client>,
  from: string,
  id: string,
  accountId: string,
  log?: Logger
): Promise<void> {
  log?.debug?.(`[${accountId}] XEP-0202 time query from ${from}`);

  const now = new Date();

  // Get timezone offset in ±HH:MM format
  const offsetMinutes = now.getTimezoneOffset();
  const offsetSign = offsetMinutes <= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const tzo = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;

  // Get UTC time in ISO 8601 format
  const utc = now.toISOString();

  const response = xml(
    "iq",
    { type: "result", to: from, id },
    xml(
      "time",
      { xmlns: NS_TIME },
      xml("tzo", {}, tzo),
      xml("utc", {}, utc)
    )
  );

  await xmpp.send(response);
  log?.debug?.(`[${accountId}] XEP-0202 time response sent to ${from}: tzo=${tzo} utc=${utc}`);
}
