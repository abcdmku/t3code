import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
} from "@t3tools/contracts/integration";
import type { ClientOrchestrationCommand } from "@t3tools/contracts/integration/unstable";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;

type StartTurnCommand = CommandOf<"thread.turn.start">;

/**
 * `thread.turn.start` with the client-side boilerplate optional. The wire
 * schema requires `messageId`, `role`, `attachments`, `runtimeMode` and
 * `interactionMode`. The SDK mints and defaults them in
 * {@link fillCommandBoilerplate}.
 */
type StartTurnCommandInput = Omit<
  StartTurnCommand,
  "commandId" | "createdAt" | "message" | "runtimeMode" | "interactionMode"
> & {
  readonly commandId?: CommandId;
  readonly createdAt?: StartTurnCommand["createdAt"];
  readonly runtimeMode?: StartTurnCommand["runtimeMode"];
  readonly interactionMode?: StartTurnCommand["interactionMode"];
  readonly message: Omit<StartTurnCommand["message"], "messageId" | "role" | "attachments"> & {
    readonly messageId?: MessageId;
    readonly role?: StartTurnCommand["message"]["role"];
    readonly attachments?: StartTurnCommand["message"]["attachments"];
  };
};

type DefaultCommandInput<T extends CommandType> = Omit<CommandOf<T>, "commandId" | "createdAt"> & {
  readonly commandId?: CommandId;
} & ("createdAt" extends keyof CommandOf<T> ? { readonly createdAt?: string } : {});

/**
 * A dispatchable orchestration command with `commandId`/`createdAt` (and the
 * `thread.turn.start` message boilerplate) optional. The SDK fills the gaps
 * before the command crosses the wire.
 */
export type DispatchableCommandInput = {
  [T in CommandType]: T extends "thread.turn.start"
    ? StartTurnCommandInput
    : DefaultCommandInput<T>;
}[CommandType];

type CommandInputByType<T extends CommandType> = Extract<
  DispatchableCommandInput,
  { readonly type: T }
>;

export type CreateThreadInput = Omit<CommandInputByType<"thread.create">, "type">;
export type StartTurnInput = Omit<CommandInputByType<"thread.turn.start">, "type">;
export type ArchiveThreadInput = Omit<CommandInputByType<"thread.archive">, "type">;

/**
 * Mirrors which command schemas in `@t3tools/contracts` carry a `createdAt`
 * field, so the SDK only stamps it where the wire shape expects it.
 */
const COMMAND_TYPES_WITH_CREATED_AT: ReadonlySet<CommandType> = new Set<CommandType>([
  "project.create",
  "thread.create",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.session.stop",
]);

// Web Crypto is available in every supported runtime (Node >= 18, browsers,
// workers), so the SDK ships its own Crypto service instead of leaking a
// platform requirement into the client layer. Digests are unused here but the
// constructor requires an implementation; delegate to SubtleCrypto.
const sdkCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(async () => {
      const input = new Uint8Array(data.length);
      input.set(data);
      return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
    }),
});

const mintUuid = sdkCrypto.randomUUIDv4.pipe(Effect.orDie);

const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const createdAtOf = (input: DispatchableCommandInput): string | undefined =>
  "createdAt" in input ? input.createdAt : undefined;

/**
 * Fills the client-side command boilerplate every integrator otherwise
 * hand-rolls: mints `commandId`/`messageId` UUIDs, stamps `createdAt`, and
 * defaults `runtimeMode`/`interactionMode` plus the message envelope on
 * `thread.turn.start`. Caller-provided values always win.
 */
export const fillCommandBoilerplate: (
  input: DispatchableCommandInput,
) => Effect.Effect<ClientOrchestrationCommand> = Effect.fn("t3Sdk.fillCommandBoilerplate")(
  function* (input) {
    const commandId = input.commandId ?? CommandId.make(yield* mintUuid);
    if (input.type === "thread.turn.start") {
      return {
        ...input,
        commandId,
        createdAt: input.createdAt ?? (yield* isoNow),
        runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        message: {
          ...input.message,
          messageId: input.message.messageId ?? MessageId.make(yield* mintUuid),
          role: "user",
          attachments: input.message.attachments ?? [],
        },
      } satisfies StartTurnCommand;
    }
    const createdAt =
      createdAtOf(input) ??
      (COMMAND_TYPES_WITH_CREATED_AT.has(input.type) ? yield* isoNow : undefined);
    // The correlation between a command's type and its optional fields is
    // erased by the union spread, so the result is asserted back into the
    // wire union after only adding fields the matching schema declares.
    return (
      createdAt === undefined ? { ...input, commandId } : { ...input, commandId, createdAt }
    ) as ClientOrchestrationCommand;
  },
);
