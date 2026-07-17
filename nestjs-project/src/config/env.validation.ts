import * as Joi from 'joi';

/**
 * Required in production; falls back to the local Docker Compose value in
 * development/test so earlier-phase suites (which don't set S3 vars) stay green.
 */
const requiredInProduction = (devDefault: string) =>
  Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().default(devDefault),
  });

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().default(6379),
  S3_ENDPOINT_INTERNAL: requiredInProduction('http://minio:9000'),
  S3_ENDPOINT_PUBLIC: requiredInProduction('http://localhost:9000'),
  S3_BUCKET: Joi.string().default('streamtube'),
  S3_ACCESS_KEY_ID: requiredInProduction('minioadmin'),
  S3_SECRET_ACCESS_KEY: requiredInProduction('minioadmin'),
  S3_REGION: Joi.string().default('us-east-1'),
  PRESIGN_EXPIRATION_SECONDS: Joi.number().default(3600),
});
