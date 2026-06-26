export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class StorageException extends DomainException {
  constructor(message: string) {
    super('STORAGE_ERROR', 500, message);
  }
}

export class BucketNotAccessibleException extends DomainException {
  constructor() {
    super('BUCKET_NOT_ACCESSIBLE', 500, 'Storage bucket is not accessible');
  }
}

export class FileNotFoundException extends DomainException {
  constructor() {
    super('FILE_NOT_FOUND', 404, 'File not found in storage');
  }
}

export class PresignUrlGenerationException extends DomainException {
  constructor(message: string) {
    super('PRESIGN_URL_GENERATION_ERROR', 500, message);
  }
}

export class QueueException extends DomainException {
  constructor(message: string) {
    super('QUEUE_ERROR', 500, message);
  }
}

export class VideoNotFoundException extends DomainException {
  constructor(message: string = 'Video not found') {
    super('VIDEO_NOT_FOUND', 404, message);
  }
}

export class VideoInvalidStatusException extends DomainException {
  constructor(message: string) {
    super('VIDEO_INVALID_STATUS', 400, message);
  }
}

export class PublicIdGenerationException extends DomainException {
  constructor(message: string) {
    super('PUBLIC_ID_GENERATION_FAILED', 500, message);
  }
}

export class StorageFileNotFoundException extends DomainException {
  constructor(message: string = 'Uploaded file not found in storage') {
    super('STORAGE_FILE_NOT_FOUND', 409, message);
  }
}
