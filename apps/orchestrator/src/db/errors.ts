export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string | number,
  ) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity}: cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Raised for any attempt to change the frozen submission record (spec §9.1). */
export class ImmutableRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableRecordError";
  }
}
