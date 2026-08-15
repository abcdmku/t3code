"use client";

import {
  PLUGIN_SURFACE_NAME_PATTERN,
  pluginSurfaceTemplateOrigin,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type PluginSurfaceEntry,
  type PluginSurfaceInspection,
  type ProjectId,
} from "@t3tools/contracts";
import { AlertTriangleIcon, GlobeIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  addPluginSurfaceEntry,
  needsPluginSurfaceConsent,
  recordPluginSurfaceGrant,
  PLUGIN_SCOPE_DESCRIPTIONS,
  type PluginSurfaceAddFailure,
} from "../../lib/pluginSurfaceSettings";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const ADD_FAILURE_MESSAGES: Record<PluginSurfaceAddFailure, string> = {
  "invalid-url": "Enter a full http or https URL. The host cannot be a placeholder.",
  "duplicate-name": "This project already has a plugin with that name.",
  "invalid-mcp-url": "The MCP URL has to be on the same origin as the page.",
};

export interface AddPluginDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly inspect: (url: string) => Promise<PluginSurfaceInspection | null>;
}

/**
 * Two steps. First the URL and what to call it, then consent.
 *
 * Consent is a separate step on purpose. Adding a plugin hands a third party a
 * token that acts as you, and that should not be a side effect of pasting a
 * URL.
 */
export function AddPluginDialog(props: AddPluginDialogProps) {
  const [step, setStep] = useState<"details" | "consent">("details");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpApproved, setMcpApproved] = useState(false);
  const [inspection, setInspection] = useState<PluginSurfaceInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);

  const origin = useMemo(() => pluginSurfaceTemplateOrigin(url.trim()), [url]);
  const scopes = useMemo<ReadonlyArray<AuthEnvironmentScope>>(() => ["orchestration:read"], []);
  const nameIsValid = PLUGIN_SURFACE_NAME_PATTERN.test(name.trim());

  const reset = useCallback(() => {
    setStep("details");
    setUrl("");
    setName("");
    setMcpUrl("");
    setMcpApproved(false);
    setInspection(null);
    setError(null);
  }, []);

  const close = useCallback(
    (open: boolean) => {
      if (!open) reset();
      props.onOpenChange(open);
    },
    [props, reset],
  );

  /**
   * Fetching the page is best effort. A plugin that is not running yet still
   * has to be addable, so a failed inspection only costs the suggested name.
   */
  const handleInspect = useCallback(async () => {
    const trimmed = url.trim();
    if (pluginSurfaceTemplateOrigin(trimmed) === null) {
      setError(ADD_FAILURE_MESSAGES["invalid-url"]);
      return;
    }
    setError(null);
    setInspecting(true);
    const result = await props.inspect(trimmed);
    setInspecting(false);
    setInspection(result);
    if (result?.suggestedName != null && name.trim() === "") setName(result.suggestedName);
  }, [name, props, url]);

  const handleContinue = useCallback(() => {
    const request = {
      origin: origin ?? "",
      scopes,
      mcpApproved: mcpUrl.trim() !== "" && mcpApproved,
    };
    if (origin === null) {
      setError(ADD_FAILURE_MESSAGES["invalid-url"]);
      return;
    }
    if (needsPluginSurfaceConsent({ grants: settings.pluginSurfaceGrants, request })) {
      setStep("consent");
      return;
    }
    void save();
  }, [mcpApproved, mcpUrl, origin, scopes, settings.pluginSurfaceGrants]);

  const save = useCallback(async () => {
    const trimmedMcpUrl = mcpUrl.trim();
    const entry: PluginSurfaceEntry = {
      name: name.trim(),
      url: url.trim(),
      scopes,
      presentation: inspection?.presentation ?? {},
      ...(trimmedMcpUrl === "" ? {} : { mcpUrl: trimmedMcpUrl }),
    };
    const existing = settings.pluginSurfaces[props.projectId] ?? [];
    const result = addPluginSurfaceEntry({ entries: existing, entry });
    if (!result.ok) {
      setError(ADD_FAILURE_MESSAGES[result.reason]);
      setStep("details");
      return;
    }

    await updateSettings({
      pluginSurfaces: { ...settings.pluginSurfaces, [props.projectId]: result.entries },
      pluginSurfaceGrants: recordPluginSurfaceGrant({
        grants: settings.pluginSurfaceGrants,
        request: {
          origin: result.origin,
          scopes,
          mcpApproved: trimmedMcpUrl !== "" && mcpApproved,
        },
        grantedAt: new Date().toISOString(),
      }),
    });
    close(false);
  }, [
    close,
    inspection,
    mcpApproved,
    mcpUrl,
    name,
    props.projectId,
    scopes,
    settings,
    updateSettings,
    url,
  ]);

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogPopup className="max-w-lg">
        {step === "details" ? (
          <>
            <DialogHeader>
              <DialogTitle>Add plugin</DialogTitle>
              <DialogDescription>
                A plugin is a page your app serves. T3 opens it in a panel and gives it a one-time
                code so it can talk to this environment.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4 px-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plugin-url">Page URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="plugin-url"
                    value={url}
                    placeholder="https://localhost:5173/panel?thread={threadId}"
                    onChange={(event) => setUrl(event.target.value)}
                    onBlur={() => void handleInspect()}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void handleInspect()}
                    disabled={inspecting}
                  >
                    {inspecting ? "Checking" : "Check"}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  {
                    "{threadId}, {projectId}, {environmentId}, and {serverUrl} are substituted on open."
                  }
                </p>
              </div>

              {inspection ? <InspectionSummary inspection={inspection} /> : null}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plugin-name">Name</Label>
                <Input
                  id="plugin-name"
                  value={name}
                  placeholder="my-plugin"
                  onChange={(event) => setName(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Lowercase letters, digits, and hyphens. Agents see this plugin&apos;s tools as
                  <code className="mx-1">mcp__{name.trim() || "my-plugin"}__*</code>.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plugin-mcp-url">MCP URL (optional)</Label>
                <Input
                  id="plugin-mcp-url"
                  value={mcpUrl}
                  placeholder="https://localhost:5173/mcp"
                  onChange={(event) => setMcpUrl(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Must be on the same origin as the page. T3 sends no headers, so keep your secrets
                  out of it.
                </p>
              </div>

              {error ? <p className="text-destructive text-sm">{error}</p> : null}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button onClick={handleContinue} disabled={!nameIsValid || origin === null}>
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Allow {origin}?</DialogTitle>
              <DialogDescription>
                This is keyed to the origin above. A page&apos;s title and icon are self-reported
                and can change at any time, so the origin is what T3 trusts.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4 px-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">This page may call T3 as you</h3>
                <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
                  {scopes.map((scope) => (
                    <li key={scope}>{PLUGIN_SCOPE_DESCRIPTIONS[scope]}</li>
                  ))}
                </ul>
              </section>

              {mcpUrl.trim() === "" ? null : (
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">Agents may use this plugin&apos;s tools</h3>
                  <Label className="flex items-start gap-2 text-sm font-normal">
                    <Checkbox
                      checked={mcpApproved}
                      onCheckedChange={(checked) => setMcpApproved(checked === true)}
                    />
                    <span className="text-muted-foreground">
                      Let agents in this project call {mcpUrl.trim()}. This is separate from the
                      grant above and you can leave it off.
                    </span>
                  </Label>
                </section>
              )}

              <p className="text-muted-foreground text-xs">
                This grant is remembered until you revoke it. It appears in
                <code className="mx-1">t3 auth session list</code>and dies with
                <code className="mx-1">t3 auth session revoke</code>.
              </p>

              {error ? <p className="text-destructive text-sm">{error}</p> : null}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep("details")}>
                Back
              </Button>
              <Button onClick={() => void save()}>Allow and add</Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

/** Self-reported, and labelled as such. */
function InspectionSummary(props: { readonly inspection: PluginSurfaceInspection }) {
  if (props.inspection.unreachable) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <AlertTriangleIcon className="size-4 shrink-0" />
        Could not reach that page. You can still add it and start the app later.
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2 text-sm">
      {props.inspection.presentation.faviconUrl ? (
        <img
          src={props.inspection.presentation.faviconUrl}
          alt=""
          className="mt-0.5 size-4 shrink-0"
        />
      ) : (
        <GlobeIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      )}
      <div className="flex flex-col">
        <span>{props.inspection.presentation.title ?? props.inspection.origin}</span>
        {props.inspection.presentation.description ? (
          <span className="text-muted-foreground text-xs">
            {props.inspection.presentation.description}
          </span>
        ) : null}
        <span className="text-muted-foreground text-xs">Reported by the page.</span>
      </div>
    </div>
  );
}
