interface T3ErrorOptions {
  readonly message: string;
  readonly cause?: unknown;
}

abstract class T3Error extends Error {
  abstract readonly _tag: string;

  constructor(options: T3ErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
  }
}

export class T3TransportError extends T3Error {
  readonly _tag = "T3TransportError";
  readonly retryable: boolean | undefined;

  constructor(options: T3ErrorOptions & { readonly retryable?: boolean }) {
    super(options);
    this.retryable = options.retryable;
  }
}

export class T3DecodeError extends T3Error {
  readonly _tag = "T3DecodeError";
}

export class T3AuthError extends T3Error {
  readonly _tag = "T3AuthError";
  readonly reason: string | undefined;
  readonly requiredScope: string | undefined;
  readonly traceId: string | undefined;

  constructor(
    options: T3ErrorOptions & {
      readonly reason?: string;
      readonly requiredScope?: string;
      readonly traceId?: string;
    },
  ) {
    super(options);
    this.reason = options.reason;
    this.requiredScope = options.requiredScope;
    this.traceId = options.traceId;
  }
}

export class T3RequestError extends T3Error {
  readonly _tag = "T3RequestError";
  readonly code: string;
  readonly traceId: string | undefined;

  constructor(options: T3ErrorOptions & { readonly code: string; readonly traceId?: string }) {
    super(options);
    this.code = options.code;
    this.traceId = options.traceId;
  }
}

export class T3CapabilityError extends T3Error {
  readonly _tag = "T3CapabilityError";
  readonly capability: string;

  constructor(options: T3ErrorOptions & { readonly capability: string }) {
    super(options);
    this.capability = options.capability;
  }
}

export class T3ConfigError extends T3Error {
  readonly _tag = "T3ConfigError";
  readonly field: string;

  constructor(options: T3ErrorOptions & { readonly field: string }) {
    super(options);
    this.field = options.field;
  }
}

export class T3InputError extends T3Error {
  readonly _tag = "T3InputError";
  readonly field: string;

  constructor(options: T3ErrorOptions & { readonly field: string }) {
    super(options);
    this.field = options.field;
  }
}

export class T3TokenPersistenceError extends T3Error {
  readonly _tag = "T3TokenPersistenceError";
}

export type T3ClientError =
  | T3TransportError
  | T3DecodeError
  | T3AuthError
  | T3RequestError
  | T3CapabilityError
  | T3ConfigError
  | T3InputError
  | T3TokenPersistenceError;

export const isT3ClientError = (value: unknown): value is T3ClientError => value instanceof T3Error;
