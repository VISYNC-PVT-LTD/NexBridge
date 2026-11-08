/**
 * Base error for expected, client-facing failures. Route handlers translate it
 * into `{ success:false, error:{ code, message } }` with `httpStatus`.
 * Lives in its own dependency-free module so both services (AuthService
 * re-exports it) and middleware (AuthError extends it) can share it.
 */
export class AppError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}
