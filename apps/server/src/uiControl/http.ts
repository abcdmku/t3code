import { AuthUiOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as UiControlBroker from "./UiControlBroker.ts";

export const uiHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "ui",
  Effect.fnUntraced(function* (handlers) {
    const broker = yield* UiControlBroker.UiControlBroker;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

    return handlers.handle(
      "invoke",
      Effect.fn("environment.ui.invoke")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthUiOperateScope);
        return yield* broker.invoke({
          environmentId: yield* serverEnvironment.getEnvironmentId,
          operation: args.payload.operation,
          input: args.payload.input,
        });
      }),
    );
  }),
);
