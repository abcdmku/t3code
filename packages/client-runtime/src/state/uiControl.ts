import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const uiControlRespondConcurrencyKey = (value: {
  readonly environmentId: string;
  readonly input: {
    readonly connectionId: string;
    readonly requestId: string;
  };
}): string =>
  JSON.stringify([value.environmentId, value.input.connectionId, value.input.requestId]);

export const uiControlHostFocusConcurrencyKey = (value: {
  readonly environmentId: string;
  readonly input: {
    readonly clientId: string;
    readonly connectionId: string;
  };
}): string => JSON.stringify([value.environmentId, value.input.clientId, value.input.connectionId]);

export function createUiControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    requests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:ui-control:requests",
      tag: WS_METHODS.uiControlConnect,
      idleTtlMs: 0,
    }),
    respond: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ui-control:respond",
      tag: WS_METHODS.uiControlRespond,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: uiControlRespondConcurrencyKey,
      },
    }),
    focusHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ui-control:focus-host",
      tag: WS_METHODS.uiControlFocusHost,
      scheduler,
      concurrency: {
        mode: "latest",
        key: uiControlHostFocusConcurrencyKey,
      },
    }),
  };
}
