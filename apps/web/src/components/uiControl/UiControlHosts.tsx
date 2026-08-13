"use client";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  UI_CONTROL_OPERATIONS,
  type EnvironmentId,
  type UiControlHost as UiControlHostRegistration,
  type UiControlRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "~/env";
import type { AppRouter } from "~/router";
import { useEnvironments } from "~/state/environments";
import { uiControlEnvironment } from "~/state/uiControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { createUiControlClientId } from "./uiControlClientId";
import { executeUiControlOperation } from "./uiControlOperations";
import { createUiControlRequestConsumerAtom } from "./uiControlRequestConsumer";
import { appUiControlThreadShellStore, revealThreadWhenKnown } from "./uiControlRevealThread";

interface UiControlCapabilityPresentation {
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: {
        readonly uiControl?: boolean;
      };
    };
  } | null;
}

interface FocusEventTarget {
  readonly addEventListener: (type: "focus" | "blur", listener: () => void) => void;
  readonly removeEventListener: (type: "focus" | "blur", listener: () => void) => void;
}

export function environmentSupportsUiControl(
  environment: UiControlCapabilityPresentation,
): boolean {
  return environment.serverConfig?.environment.capabilities.uiControl === true;
}

export function createUiControlHostRegistration(
  environmentId: EnvironmentId,
  clientId: UiControlHostRegistration["clientId"],
): UiControlHostRegistration {
  return {
    clientId,
    environmentId,
    supportedOperations: [...UI_CONTROL_OPERATIONS],
  };
}

export function subscribeUiControlFocusEvents(
  target: FocusEventTarget,
  report: () => void,
): () => void {
  report();
  target.addEventListener("focus", report);
  target.addEventListener("blur", report);
  return () => {
    target.removeEventListener("focus", report);
    target.removeEventListener("blur", report);
  };
}

export function UiControlHosts(props: { readonly router: AppRouter }) {
  const { environments } = useEnvironments();
  return (
    <>
      {/* React Native does not mount this web host. */}
      {environments.filter(environmentSupportsUiControl).map((environment) => (
        <UiControlHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
          router={props.router}
        />
      ))}
    </>
  );
}

function UiControlHost(props: {
  readonly environmentId: EnvironmentId;
  readonly router: AppRouter;
}) {
  const { environmentId, router } = props;
  const [clientId] = useState(createUiControlClientId);
  const registration = useMemo(
    () => createUiControlHostRegistration(environmentId, clientId),
    [clientId, environmentId],
  );
  const requestsAtom = uiControlEnvironment.requests({
    environmentId,
    input: registration,
  });
  const respond = useAtomCommand(uiControlEnvironment.respond, {
    label: "ui control response",
    reportFailure: false,
  });
  const focusHost = useAtomCommand(uiControlEnvironment.focusHost, {
    label: "ui control host focus",
    reportFailure: false,
  });
  const [connectionAtom] = useState(() => Atom.make<string | null>(null));
  const connectionId = useAtomValue(connectionAtom);

  const handleRequest = useCallback(
    async (request: UiControlRequest, signal: AbortSignal): Promise<void> => {
      await executeUiControlOperation(
        request,
        {
          environmentId,
          revealThread: async (threadRef, operationSignal) => {
            await revealThreadWhenKnown({
              threadRef,
              store: appUiControlThreadShellStore,
              signal: operationSignal,
              navigate: async (ref) => {
                await router.navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(ref),
                });
              },
            });

            if (isElectron && !operationSignal.aborted) {
              await window.desktopBridge?.revealWindow?.().catch(() => undefined);
            }
          },
        },
        signal,
      );
    },
    [environmentId, router],
  );
  const [requestHandlerAtom] = useState(() => Atom.make({ handle: handleRequest }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest });
  }, [handleRequest, setRequestHandler]);

  const requestConsumerAtom = useMemo(
    () =>
      createUiControlRequestConsumerAtom({
        requestsAtom,
        clientId,
        connectionAtom,
        requestHandlerAtom,
        respond: (response) =>
          respond({
            environmentId,
            input: response,
          }),
        label: `ui-control:host:${environmentId}:${clientId}`,
      }),
    [clientId, connectionAtom, environmentId, requestHandlerAtom, requestsAtom, respond],
  );
  useAtomValue(requestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!connectionId) return;
      void focusHost({
        environmentId,
        input: {
          clientId,
          environmentId,
          connectionId,
          focused: document.hasFocus(),
        },
      });
    };
    return subscribeUiControlFocusEvents(window, report);
  }, [clientId, connectionId, environmentId, focusHost]);

  return null;
}
