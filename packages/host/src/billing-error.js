/** A billing failure with the HTTP status to answer with and a message that is safe to show. */
export class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
