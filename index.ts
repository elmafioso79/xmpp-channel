import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xmppPlugin } from "./src/channel.js";
import { setXmppRuntime } from "./src/runtime.js";

const plugin = {
  id: "xmpp",
  name: "XMPP",
  description: "XMPP channel plugin (Prosody, ejabberd)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi): void {
    setXmppRuntime(api.runtime);
    api.registerChannel({ plugin: xmppPlugin });
  },
};

export default plugin;

// Re-export utilities for external use
export { xmppPlugin } from "./src/channel.js";
export { xmppOnboardingAdapter } from "./src/onboarding.js";
export { listXmppAccountIds, resolveDefaultXmppAccountId, resolveXmppAccount } from "./src/accounts.js";
export { collectXmppStatusIssues } from "./src/status-issues.js";
export { looksLikeXmppJid, normalizeXmppTarget, normalizeXmppMessagingTarget } from "./src/normalize.js";
export { XmppConfigSchema } from "./src/config-schema.js";
export type { XmppConfig, ResolvedXmppAccount, XmppInboundMessage } from "./src/types.js";

// PEP (XEP-0163) exports
export {
  pepPublish,
  pepFetch,
  pepSubscribe,
  pepRetract,
  pepDeleteNode,
  pepGetNodeConfig,
  parsePepEvent,
  publishNickname,
  publishMood,
  clearMood,
  NS_PUBSUB,
  NS_PUBSUB_EVENT,
  NS_NICK,
  NS_MOOD,
} from "./src/pep.js";
export type { PepItem, PepResult, PepPublishOptions } from "./src/pep.js";

// HTTP Upload (XEP-0363) exports
export {
  discoverUploadService,
  requestUploadSlot,
  uploadFile,
  uploadAndGetUrl,
  getUploadService,
  buildOobElement,
  parseOobData,
  NS_HTTP_UPLOAD,
  NS_OOB,
} from "./src/http-upload.js";
export type { UploadSlot, UploadResult, HttpUploadConfig } from "./src/http-upload.js";

// Monitor exports
export { getActiveClient, registerPepEventHandler, unregisterPepEventHandler } from "./src/monitor.js";
