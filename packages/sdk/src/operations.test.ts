import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { T3Client } from "./Client.ts";
import type { DispatchableCommandInput } from "./commands.ts";
import { T3CapabilityError } from "./errors.ts";
import { archiveThread, createThread, requireCapability, startTurn } from "./operations.ts";

const isT3CapabilityError = (value: unknown): value is T3CapabilityError =>
  value instanceof T3CapabilityError;

const makeDescriptor = (
  capabilities: ExecutionEnvironmentDescriptor["capabilities"],
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities,
});

const makeStubClient = (descriptor: ExecutionEnvironmentDescriptor) => {
  const dispatched: Array<DispatchableCommandInput> = [];
  const clientLayer = Layer.succeed(
    T3Client,
    T3Client.of({
      descriptor: Effect.succeed(descriptor),
      shell: Effect.die(new Error("shell is not stubbed")),
      thread: () => Effect.die(new Error("thread is not stubbed")),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      subscribeShell: Stream.empty,
      subscribeThread: () => Stream.empty,
    }),
  );
  return { clientLayer, dispatched };
};

describe("operations", () => {
  it.effect("createThread dispatches thread.create with the caller's fields", () =>
    Effect.gen(function* () {
      const { clientLayer, dispatched } = makeStubClient(
        makeDescriptor({ repositoryIdentity: true }),
      );
      const result = yield* createThread({
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Sketch pad",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }).pipe(Effect.provide(clientLayer));
      expect(result).toEqual({ sequence: 1 });
      expect(dispatched[0]).toMatchObject({
        type: "thread.create",
        threadId: "thread-1",
        projectId: "project-1",
        title: "Sketch pad",
      });
    }),
  );

  it.effect("startTurn dispatches thread.turn.start", () =>
    Effect.gen(function* () {
      const { clientLayer, dispatched } = makeStubClient(
        makeDescriptor({ repositoryIdentity: true }),
      );
      yield* startTurn({
        threadId: ThreadId.make("thread-1"),
        message: { text: "start guessing" },
      }).pipe(Effect.provide(clientLayer));
      expect(dispatched[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-1",
        message: { text: "start guessing" },
      });
    }),
  );

  it.effect("archiveThread dispatches thread.archive", () =>
    Effect.gen(function* () {
      const { clientLayer, dispatched } = makeStubClient(
        makeDescriptor({ repositoryIdentity: true }),
      );
      yield* archiveThread({ threadId: ThreadId.make("thread-1") }).pipe(
        Effect.provide(clientLayer),
      );
      expect(dispatched[0]).toMatchObject({ type: "thread.archive", threadId: "thread-1" });
    }),
  );

  it.effect("requireCapability returns the descriptor when the flag is advertised", () =>
    Effect.gen(function* () {
      const { clientLayer } = makeStubClient(
        makeDescriptor({ repositoryIdentity: true, threadSettlement: true }),
      );
      const descriptor = yield* requireCapability("threadSettlement").pipe(
        Effect.provide(clientLayer),
      );
      expect(descriptor.capabilities.threadSettlement).toBe(true);
    }),
  );

  it.effect("requireCapability fails with T3CapabilityError when the flag is absent", () =>
    Effect.gen(function* () {
      const { clientLayer } = makeStubClient(makeDescriptor({ repositoryIdentity: true }));
      const error = yield* requireCapability("threadSnooze").pipe(
        Effect.provide(clientLayer),
        Effect.flip,
      );
      expect(isT3CapabilityError(error)).toBe(true);
      if (isT3CapabilityError(error)) {
        expect(error.capability).toBe("threadSnooze");
      }
    }),
  );
});
