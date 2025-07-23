export default class AppError extends Error {
  constructor(message, status, errors = []) {
    super(message);
    this.status = status || 500;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}