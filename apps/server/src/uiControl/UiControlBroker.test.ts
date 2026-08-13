import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type UiControlHost, type UiControlStreamEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as UiControlBroker from "./UiControlBroker.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeBroker = UiControlBroker.make.pipe(Effect.provide(NodeServices.layer));

const makeHost = (overrides: Partial<UiControlHost> = {}): UiControlHost => ({
  clientId: "client-1",
  environmentId,
  supportedOperations: ["ui.revealThread"],
  ...overrides,
});

const invoke = (broker: UiControlBroker.UiControlBroker["Service"], timeoutMs = 15_000) =>
  broker.invoke({
    environmentId,
    operation: "ui.revealThread",
    input: { threadId: "thread-1" },
    timeoutMs,
  });

it.effect("routes a request to a host and accepts its correlated response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const connected = yield* Deferred.make<void>();
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        if (event.type === "cancel") return Effect.void;
        return broker.respond({
          clientId: "client-1",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      expect(yield* invoke(broker)).toEqual({ delivered: true });
    }),
  ),
);

it.effect("keeps requests inside their environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(
        makeHost({ environmentId: EnvironmentId.make("environment-2") }),
      );
      const connected = yield* Deferred.make<void>();
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected" ? Deferred.succeed(connected, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const result = yield* invoke(broker);
      expect(result.delivered).toBe(false);
      if (!result.delivered) expect(result.error).toContain("No connected UI control host");
    }),
  ),
);

it.effect("sends a cancel event when an invocation times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const connected = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<Extract<UiControlStreamEvent, { type: "cancel" }>>();
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        if (event.type === "cancel") return Deferred.succeed(cancelled, event);
        return Effect.void;
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const pending = yield* invoke(broker, 5_000).pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(pending);
      const cancellation = yield* Deferred.await(cancelled);

      expect(result.delivered).toBe(false);
      expect(cancellation.requestId).toBeDefined();
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("sends a cancel event when the caller interrupts an invocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const connected = yield* Deferred.make<void>();
      const routed = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        if (event.type === "request") return Deferred.succeed(routed, undefined);
        return Deferred.succeed(cancelled, undefined);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const pending = yield* invoke(broker).pipe(Effect.forkScoped);
      yield* Deferred.await(routed);
      yield* Fiber.interrupt(pending);
      yield* Deferred.await(cancelled);
    }),
  ),
);

it.effect("does not deliver a queued request after it times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const connected = yield* Deferred.make<void>();
      const startReading = yield* Deferred.make<void>();
      const observed = yield* Deferred.make<UiControlStreamEvent>();
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") {
          return Deferred.succeed(connected, undefined).pipe(
            Effect.andThen(Deferred.await(startReading)),
          );
        }
        return Deferred.succeed(observed, event);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const pending = yield* invoke(broker, 5_000).pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(pending);
      yield* Deferred.succeed(startReading, undefined);

      expect((yield* Deferred.await(observed)).type).toBe("cancel");
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("caps pending work and frees capacity after a response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const connected = yield* Deferred.make<void>();
      const firstRequest =
        yield* Deferred.make<Extract<UiControlStreamEvent, { type: "request" }>>();
      const routedCount = yield* Ref.make(0);
      const allRouted = yield* Deferred.make<void>();
      const respondToNewRequests = yield* Ref.make(false);
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        if (event.type === "cancel") return Effect.void;
        return Effect.gen(function* () {
          yield* Deferred.succeed(firstRequest, event);
          const count = yield* Ref.updateAndGet(routedCount, (value) => value + 1);
          if (count === 64) yield* Deferred.succeed(allRouted, undefined);
          if (yield* Ref.get(respondToNewRequests)) {
            yield* broker.respond({
              clientId: "client-1",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
            });
          }
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const pending = yield* Effect.forEach(Array.from({ length: 64 }), () =>
        invoke(broker).pipe(Effect.forkScoped),
      );
      yield* Deferred.await(allRouted);

      expect(yield* invoke(broker)).toEqual({
        delivered: false,
        error: "The UI control host is busy.",
      });

      const first = yield* Deferred.await(firstRequest);
      yield* broker.respond({
        clientId: "client-1",
        connectionId: first.connectionId,
        requestId: first.request.requestId,
        ok: true,
      });
      yield* Fiber.join(pending[0]!);
      yield* Ref.set(respondToNewRequests, true);

      expect(yield* invoke(broker)).toEqual({ delivered: true });
    }),
  ),
);
