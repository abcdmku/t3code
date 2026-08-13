import { createUiControlEnvironmentAtoms } from "@t3tools/client-runtime/state/ui-control";

import { connectionAtomRuntime } from "../connection/runtime";

export const uiControlEnvironment = createUiControlEnvironmentAtoms(connectionAtomRuntime);
