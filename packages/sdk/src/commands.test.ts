import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { fillCommandBoilerplate } from "./commands.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// it.effect runs under TestClock, so stamped timestamps are the virtual epoch.
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

describe("fillCommandBoilerplate", () => {
  it.effect("mints ids, stamps createdAt and defaults modes on thread.turn.start", () =>
    Effect.gen(function* () {
      const command = yield* fillCommandBoilerplate({
        type: "thread.turn.start",
        threadId: ThreadId.make("thread-1"),
        message: { text: "guess the drawing" },
      });
      expect(command.type).toBe("thread.turn.start");
      if (command.type !== "thread.turn.start") {
        return;
      }
      expect(command.commandId).toMatch(UUID_PATTERN);
      expect(command.createdAt).toBe(EPOCH_ISO);
      expect(command.runtimeMode).toBe("full-access");
      expect(command.interactionMode).toBe("default");
      expect(command.message.messageId).toMatch(UUID_PATTERN);
      expect(command.message.messageId).not.toBe(command.commandId);
      expect(command.message.role).toBe("user");
      expect(command.message.attachments).toEqual([]);
    }),
  );

  it.effect("keeps caller-provided identifiers, timestamps and modes", () =>
    Effect.gen(function* () {
      const attachment = {
        type: "image" as const,
        name: "sketch.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,aGk=",
      };
      const command = yield* fillCommandBoilerplate({
        type: "thread.turn.start",
        commandId: CommandId.make("command-1"),
        createdAt: "2026-05-01T12:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        interactionMode: "plan",
        message: {
          messageId: MessageId.make("message-1"),
          text: "keep these",
          attachments: [attachment],
        },
      });
      expect(command).toMatchObject({
        type: "thread.turn.start",
        commandId: "command-1",
        createdAt: "2026-05-01T12:00:00.000Z",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        message: {
          messageId: "message-1",
          role: "user",
          attachments: [attachment],
        },
      });
    }),
  );

  it.effect("adds createdAt only to commands whose wire shape carries it", () =>
    Effect.gen(function* () {
      const archive = yield* fillCommandBoilerplate({
        type: "thread.archive",
        threadId: ThreadId.make("thread-1"),
      });
      expect(archive.commandId).toMatch(UUID_PATTERN);
      expect("createdAt" in archive).toBe(false);

      const stop = yield* fillCommandBoilerplate({
        type: "thread.session.stop",
        threadId: ThreadId.make("thread-1"),
      });
      expect(stop).toMatchObject({ type: "thread.session.stop", createdAt: EPOCH_ISO });
    }),
  );
});
