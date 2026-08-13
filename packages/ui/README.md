# @t3tools/ui

React components and theme tokens used by the T3 Code web client.

This package is not published to npm yet. Use the workspace package or a local tarball.

## Use it in this workspace

Add the workspace dependency to the consuming package:

```json
{
  "dependencies": {
    "@t3tools/ui": "workspace:*"
  }
}
```

Import the theme and tell Tailwind v4 where to scan the component source. Adjust the relative path for your app:

```css
@import "tailwindcss";
@import "@t3tools/ui/theme.css";
@source "../../../packages/ui/src";
```

## Use a local tarball

Build and pack the package from the repository root:

```sh
pnpm --filter @t3tools/ui pack --pack-destination ./artifacts
```

Install the generated `.tgz` file in a React 19 and Tailwind 4 app. The app must also install `@base-ui/react`.

```sh
pnpm add ../t3code/artifacts/t3tools-ui-0.0.33.tgz
pnpm add @base-ui/react react react-dom tailwindcss
```

Scan the compiled files when the package comes from a tarball:

```css
@import "tailwindcss";
@import "@t3tools/ui/theme.css";
@source "../node_modules/@t3tools/ui/dist";
```

## Import components

Import each component from its named subpath. The package has no root export.

```tsx
import { Button } from "@t3tools/ui/button";
import { CheckIcon } from "lucide-react";

export function SaveButton() {
  return (
    <Button variant="default">
      <CheckIcon />
      Save
    </Button>
  );
}
```

Dialogs compose Base UI parts. The popup adds the portal, backdrop, and viewport:

```tsx
import { Button } from "@t3tools/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@t3tools/ui/dialog";

export function DeleteDialog() {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="destructive" />}>Delete project</DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
          <DialogDescription>This removes the local project record.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
          <Button variant="destructive">Delete</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
```

Form controls accept normal React props:

```tsx
import { Field, FieldDescription, FieldLabel } from "@t3tools/ui/field";
import { Input } from "@t3tools/ui/input";
import { Switch } from "@t3tools/ui/switch";

export function ProjectFields() {
  return (
    <div className="grid gap-4">
      <Field>
        <FieldLabel>Project name</FieldLabel>
        <Input name="projectName" placeholder="t3code" />
        <FieldDescription>Used in the project list.</FieldDescription>
      </Field>
      <label className="flex items-center gap-2">
        <Switch name="notifications" />
        Notify when a turn finishes
      </label>
    </div>
  );
}
```

## Set theme values

`theme.css` supplies the defaults. Override its CSS variables after the import. Add `dark` to an ancestor to use the dark values and dark Tailwind variant.

```css
:root {
  --primary: oklch(0.58 0.21 264);
  --radius: 0.75rem;
  --glass-opacity: 88%;
}
```

```tsx
export function DarkPanel({ children }: { children: React.ReactNode }) {
  return <section className="dark bg-background text-foreground">{children}</section>;
}
```

The package exports components through subpaths such as `button`, `dialog`, `input`, `menu`, `select`, `table`, `tooltip`, and `cn`. Read `package.json` for the full list.
