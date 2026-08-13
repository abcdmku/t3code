import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  EnvironmentAuthHttpApi,
  EnvironmentMetadataHttpApi,
  EnvironmentOrchestrationHttpApi,
  EnvironmentUiHttpApi,
} from "./environmentHttp.ts";
import { WsOrchestrationSubscribeShellRpc, WsOrchestrationSubscribeThreadRpc } from "./rpc.ts";

export { EnvironmentAuthorizationError } from "./auth.ts";

export {
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";
export {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotError,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
} from "./orchestration.ts";

export const IntegrationEnvironmentHttpApi = HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentUiHttpApi);

export const IntegrationWsRpcGroup = RpcGroup.make(
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
