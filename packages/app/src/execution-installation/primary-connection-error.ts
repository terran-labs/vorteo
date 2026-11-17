/**
 * The chosen connection cannot become primary: it was removed or turned off, its profile does
 * not belong to it, or a resolver found nothing usable in the current settings. Nothing was saved.
 */
export class PrimaryConnectionUnavailableError extends Error {
  constructor(message = "That connection is no longer available.") {
    super(message);
    this.name = "PrimaryConnectionUnavailableError";
  }
}
