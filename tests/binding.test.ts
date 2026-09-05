import { describe, expect, it } from "vitest";
import {
  appendBindingEntry,
  getMatchingBindingEntries,
  resolveBindingState,
  validateBindingData,
} from "../src/binding.js";
import { BINDING_CUSTOM_TYPE } from "../src/types.js";

describe("binding module", () => {
  describe("validateBindingData", () => {
    it("validates positive threadId entry", () => {
      const valid = {
        version: 1,
        sessionId: "sess-123",
        chatId: -100123,
        threadId: 456,
      };
      expect(validateBindingData(valid)).toEqual(valid);
    });

    it("validates disconnected tombstone (threadId: null)", () => {
      const tombstone = {
        version: 1,
        sessionId: "sess-123",
        chatId: -100123,
        threadId: null,
      };
      expect(validateBindingData(tombstone)).toEqual(tombstone);
    });

    it("rejects invalid versions", () => {
      expect(
        validateBindingData({
          version: 2,
          sessionId: "sess-123",
          chatId: 1,
          threadId: 1,
        })
      ).toBeNull();
    });

    it("rejects non-positive or float threadId", () => {
      expect(
        validateBindingData({
          version: 1,
          sessionId: "s",
          chatId: 1,
          threadId: 0,
        })
      ).toBeNull();
      expect(
        validateBindingData({
          version: 1,
          sessionId: "s",
          chatId: 1,
          threadId: -1,
        })
      ).toBeNull();
      expect(
        validateBindingData({
          version: 1,
          sessionId: "s",
          chatId: 1,
          threadId: 1.5,
        })
      ).toBeNull();
    });
  });

  describe("getMatchingBindingEntries and resolveBindingState", () => {
    const currentSession = "session-main";
    const currentChat = -100999;

    it("returns empty when no matching entries exist", () => {
      const entries = [
        { type: "message", id: "m1", message: { role: "user" } },
        { type: "custom", customType: "other.tool", data: {} },
      ];
      expect(getMatchingBindingEntries(entries, currentSession, currentChat)).toEqual([]);

      const state = resolveBindingState(entries, currentSession, currentChat);
      expect(state).toEqual({
        state: "unbound",
        threadId: null,
        lastValidThreadId: null,
      });
    });

    it("ignores entries from different session IDs (fork/clone simulation)", () => {
      const entries = [
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: "source-parent-session",
            chatId: currentChat,
            threadId: 111,
          },
        },
      ];

      const matching = getMatchingBindingEntries(entries, currentSession, currentChat);
      expect(matching).toEqual([]);

      const state = resolveBindingState(entries, currentSession, currentChat);
      expect(state.state).toBe("unbound");
      expect(state.threadId).toBeNull();
    });

    it("ignores entries from different chat IDs", () => {
      const entries = [
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: currentSession,
            chatId: -999999, // different chat
            threadId: 111,
          },
        },
      ];

      const matching = getMatchingBindingEntries(entries, currentSession, currentChat);
      expect(matching).toEqual([]);
    });

    it("resolves bound state from valid matching entry", () => {
      const entries = [
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: currentSession,
            chatId: currentChat,
            threadId: 42,
          },
        },
      ];

      const state = resolveBindingState(entries, currentSession, currentChat);
      expect(state).toEqual({
        state: "bound",
        threadId: 42,
        lastValidThreadId: 42,
      });
    });

    it("resolves disconnected state while remembering lastValidThreadId", () => {
      const entries = [
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: currentSession,
            chatId: currentChat,
            threadId: 42,
          },
        },
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: currentSession,
            chatId: currentChat,
            threadId: null, // disconnect
          },
        },
      ];

      const state = resolveBindingState(entries, currentSession, currentChat);
      expect(state).toEqual({
        state: "disconnected",
        threadId: null,
        lastValidThreadId: 42,
      });
    });

    it("resolves reconnected state correctly in order of append", () => {
      const entries = [
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: currentSession,
            chatId: currentChat,
            threadId: 42,
          },
        },
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: currentSession,
            chatId: currentChat,
            threadId: null,
          },
        },
        {
          type: "custom",
          customType: BINDING_CUSTOM_TYPE,
          data: {
            version: 1,
            sessionId: currentSession,
            chatId: currentChat,
            threadId: 99,
          },
        },
      ];

      const state = resolveBindingState(entries, currentSession, currentChat);
      expect(state).toEqual({
        state: "bound",
        threadId: 99,
        lastValidThreadId: 99,
      });
    });
  });

  describe("appendBindingEntry", () => {
    it("appends and verifies successfully", () => {
      const sessionEntries: unknown[] = [];
      const mockPi = {
        appendEntry: (customType: string, data: unknown) => {
          sessionEntries.push({
            type: "custom",
            customType,
            data,
          });
        },
      } as any;

      const mockCtx = {
        sessionManager: {
          getSessionId: () => "sess-abc",
          getEntries: () => sessionEntries,
        },
      } as any;

      const ok = appendBindingEntry(mockPi, mockCtx, 12345, 678);
      expect(ok).toBe(true);
      expect(sessionEntries.length).toBe(1);
      expect(sessionEntries[0]).toEqual({
        type: "custom",
        customType: BINDING_CUSTOM_TYPE,
        data: {
          version: 1,
          sessionId: "sess-abc",
          chatId: 12345,
          threadId: 678,
        },
      });
    });

    it("rejects invalid threadId", () => {
      const mockPi = { appendEntry: () => {} } as any;
      const mockCtx = {
        sessionManager: { getSessionId: () => "sess-1" },
      } as any;

      expect(appendBindingEntry(mockPi, mockCtx, 12345, -5)).toBe(false);
      expect(appendBindingEntry(mockPi, mockCtx, 12345, 0)).toBe(false);
    });
  });
});
