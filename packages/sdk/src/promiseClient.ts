import {
  ThreadId,
  type DispatchResult,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts/integration";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";

import { T3Client } from "./Client.ts";
import type {
  ArchiveThreadInput as EffectArchiveThreadInput,
  CreateThreadInput as EffectCreateThreadInput,
  StartTurnInput as EffectStartTurnInput,
} from "./commands.ts";
import { archiveThread, createThread, startTurn } from "./operations.ts";
import { T3InputError, T3TransportError, type T3ClientError } from "./errors.ts";

type Plain<T> = T extends string
  ? string
  : T extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Plain<Item>>
    : T extends object
      ? { readonly [Key in keyof T]: Plain<T[Key]> }
      : T;

export type CreateThreadInput = Plain<EffectCreateThreadInput>;
export type StartTurnInput = Plain<EffectStartTurnInput>;
export type ArchiveThreadInput = Plain<EffectArchiveThreadInput>;

const nonEmptyId = (value: string, field: string): Effect.Effect<ThreadId, T3InputError> =>
  value.trim() === ""
    ? Effect.fail(new T3InputError({ message: `${field} must not be empty.`, field }))
    : Effect.succeed(ThreadId.make(value));

const validateCreateThread = (
  input: CreateThreadInput,
): Effect.Effect<EffectCreateThreadInput, T3InputError> =>
  input.threadId.trim() === "" || input.projectId.trim() === "" || input.title.trim() === ""
    ? Effect.fail(
        new T3InputError({
          message: "threadId, projectId, and title must not be empty.",
          field: "createThread",
        }),
      )
    : input.modelSelection.instanceId.trim() === "" || input.modelSelection.model.trim() === ""
      ? Effect.fail(
          new T3InputError({
            message: "modelSelection.instanceId and modelSelection.model must not be empty.",
            field: "createThread.modelSelection",
          }),
        )
      : Effect.succeed(input as EffectCreateThreadInput);

const validateStartTurn = (
  input: StartTurnInput,
): Effect.Effect<EffectStartTurnInput, T3InputError> =>
  input.threadId.trim() === ""
    ? Effect.fail(
        new T3InputError({ message: "threadId must not be empty.", field: "startTurn.threadId" }),
      )
    : Effect.succeed(input as EffectStartTurnInput);

const validateArchiveThread = (
  input: ArchiveThreadInput,
): Effect.Effect<EffectArchiveThreadInput, T3InputError> =>
  input.threadId.trim() === ""
    ? Effect.fail(
        new T3InputError({
          message: "threadId must not be empty.",
          field: "archiveThread.threadId",
        }),
      )
    : Effect.succeed(input as EffectArchiveThreadInput);

/**
 * Plain async client for apps that do not use Effect. Methods return promises,
 * subscriptions are async iterables, and failures use {@link T3ClientError}.
 */
export interface T3PromiseClient {
  readonly descriptor: () => Promise<ExecutionEnvironmentDescriptor>;
  readonly shell: () => Promise<OrchestrationShellSnapshot>;
  readonly thread: (threadId: string) => Promise<OrchestrationThreadDetailSnapshot>;
  readonly createThread: (input: CreateThreadInput) => Promise<DispatchResult>;
  readonly startTurn: (input: StartTurnInput) => Promise<DispatchResult>;
  readonly archiveThread: (input: ArchiveThreadInput) => Promise<DispatchResult>;
  readonly subscribeShell: () => AsyncIterable<OrchestrationShellStreamItem>;
  readonly subscribeThread: (threadId: string) => AsyncIterable<OrchestrationThreadStreamItem>;
  /**
   * Interrupts every subscription iterator this client produced. Pending and
   * subsequent `next()` calls resolve as `{ done: true }`. Iterators created
   * after closing begins do the same. Then the client releases its runtime.
   * Method calls made after `close()` reject with a `T3TransportError`
   * explaining that the client is closed. Idempotent; resolves once
   * everything is released.
   */
  readonly close: () => Promise<void>;
}

/**
 * Builds the Promise facade from an already-assembled `T3Client` layer, for
 * Effect consumers who compose their own layers, such as tests with a stubbed
 * WebSocket transport. Apps that do not use Effect should call
 * `createT3Client` from `@t3tools/sdk`.
 */
export const createT3ClientFromLayer = (
  clientLayer: Layer.Layer<T3Client, T3ClientError>,
): T3PromiseClient => {
  const runtime = ManagedRuntime.make(clientLayer);
  // Cleanup callbacks for iterators that have not finished yet; close()
  // drains this set so no subscription fiber outlives the client.
  const activeSubscriptions = new Set<() => Promise<void>>();
  // Memoized close state. Once set, the runtime must be treated as disposed:
  // Every existing or new iterator settles as `{ done: true }`
  // and plain method calls reject, without ever touching the runtime again.
  let closing: Promise<void> | undefined;

  const closedError = (): T3TransportError =>
    new T3TransportError({
      message: "The client is closed; no further requests can be made. Create a new client.",
    });

  const doneResult = <A>(): IteratorResult<A> => ({ done: true as const, value: undefined });

  const run = <A>(effect: Effect.Effect<A, T3ClientError, T3Client>): Promise<A> =>
    closing !== undefined
      ? Promise.reject(closedError())
      : runtime.runPromiseExit(effect).then((exit) => {
          if (Exit.isSuccess(exit)) {
            return exit.value;
          }
          throw Cause.squash(exit.cause);
        });

  const iterate = <A>(
    select: (service: T3Client["Service"]) => Stream.Stream<A, T3ClientError>,
  ): AsyncIterable<A> => ({
    [Symbol.asyncIterator]: () => {
      let iteratorPromise: Promise<AsyncIterator<A>> | undefined;
      let teardownPromise: Promise<void> | undefined;
      const stop = (value?: unknown): Promise<void> =>
        (teardownPromise ??=
          iteratorPromise === undefined
            ? Promise.resolve()
            : iteratorPromise
                .then((iterator) => iterator.return?.(value))
                .then(
                  () => undefined,
                  () => undefined,
                ));
      if (closing === undefined) {
        activeSubscriptions.add(stop);
      }
      const finish = () => activeSubscriptions.delete(stop);
      const acquire = () =>
        (iteratorPromise ??= run(
          Effect.gen(function* () {
            const service = yield* T3Client;
            return select(service);
          }),
        ).then((stream) => Stream.toAsyncIterable(stream)[Symbol.asyncIterator]()));
      return {
        next: () => {
          if (closing !== undefined) {
            finish();
            return Promise.resolve(doneResult<A>());
          }
          return acquire()
            .then((iterator) =>
              iterator.next().then((result) => {
                if (closing !== undefined) {
                  finish();
                  return doneResult<A>();
                }
                if (result.done) {
                  finish();
                }
                return result;
              }),
            )
            .catch((error: unknown) => {
              finish();
              // The rejection raced with close(). It may come from runtime
              // disposal or iterator interruption. A closed iterator ends.
              if (closing !== undefined) {
                return doneResult<A>();
              }
              // Not closing: typed stream failures must reach the consumer.
              throw error;
            });
        },
        return: (value?: unknown) => {
          if (closing !== undefined || iteratorPromise === undefined) {
            finish();
            return Promise.resolve(doneResult<A>());
          }
          // Deregister only once the underlying cleanup has settled, so a
          // concurrent close() keeps awaiting this iterator's finalizers.
          return stop(value)
            .then(doneResult<A>)
            .finally(finish);
        },
        throw: (error?: unknown) => {
          if (closing !== undefined) {
            finish();
            return Promise.resolve(doneResult<A>());
          }
          if (iteratorPromise === undefined) {
            finish();
            return Promise.reject(error);
          }
          // As with return(): keep the stop callback registered until the
          // underlying iterator has actually finished tearing down.
          return acquire()
            .then((iterator) =>
              iterator.throw !== undefined ? iterator.throw(error) : Promise.reject(error),
            )
            .finally(finish);
        },
      };
    },
  });

  return {
    descriptor: () =>
      run(
        Effect.gen(function* () {
          const service = yield* T3Client;
          return yield* service.descriptor;
        }),
      ),
    shell: () =>
      run(
        Effect.gen(function* () {
          const service = yield* T3Client;
          return yield* service.shell;
        }),
      ),
    thread: (threadId) =>
      run(
        Effect.gen(function* () {
          const id = yield* nonEmptyId(threadId, "threadId");
          const service = yield* T3Client;
          return yield* service.thread(id);
        }),
      ),
    createThread: (input) => run(validateCreateThread(input).pipe(Effect.flatMap(createThread))),
    startTurn: (input) => run(validateStartTurn(input).pipe(Effect.flatMap(startTurn))),
    archiveThread: (input) => run(validateArchiveThread(input).pipe(Effect.flatMap(archiveThread))),
    subscribeShell: () => iterate((service) => service.subscribeShell),
    subscribeThread: (threadId) =>
      iterate((service) =>
        Stream.unwrap(nonEmptyId(threadId, "threadId").pipe(Effect.map(service.subscribeThread))),
      ),
    close: () => {
      if (closing === undefined) {
        const stops = Array.from(activeSubscriptions);
        activeSubscriptions.clear();
        closing = Promise.all(stops.map((stop) => stop())).then(() => runtime.dispose());
      }
      return closing;
    },
  };
};
