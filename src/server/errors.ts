export class AppError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422 | 500 | 503 | 504 = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
