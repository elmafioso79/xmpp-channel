import { afterEach, describe, expect, it } from "vitest";
import { isKnownMucRoom, joinedRooms } from "../src/state.js";

describe("isKnownMucRoom", () => {
  afterEach(() => {
    joinedRooms.clear();
  });

  it("matches configured rooms by bare JID", () => {
    expect(isKnownMucRoom("default", "room@conference.example.com/bot", ["room@conference.example.com"])).toBe(true);
  });

  it("matches rooms joined at runtime even when not configured", () => {
    joinedRooms.set("default", new Set(["invite@muc.example.com"]));
    expect(isKnownMucRoom("default", "invite@muc.example.com/agent", [])).toBe(true);
  });

  it("returns false for unknown non-MUC targets", () => {
    expect(isKnownMucRoom("default", "user@example.com", ["room@conference.example.com"])).toBe(false);
  });
});
