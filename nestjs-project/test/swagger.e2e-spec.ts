import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { buildSwaggerConfig } from '../src/swagger/swagger-document';

async function createApp(
  withSwagger: boolean,
): Promise<{ app: INestApplication<App>; module: TestingModule }> {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = module.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );

  if (withSwagger) {
    const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'StreamTube API Docs',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.init();
  return { app, module };
}

describe('Swagger endpoints (e2e)', () => {
  describe('when SWAGGER_ENABLED=true', () => {
    let app: INestApplication<App>;
    let module: TestingModule;

    beforeAll(async () => {
      process.env.SWAGGER_ENABLED = 'true';
      const result = await createApp(true);
      app = result.app;
      module = result.module;
    }, 30000);

    afterAll(async () => {
      if (app) {
        try {
          await app.close();
        } catch {
          // Ignore cleanup errors
        }
      }

      if (module) {
        try {
          await module.close();
        } catch {
          // Ignore cleanup errors
        }
      }

      delete process.env.SWAGGER_ENABLED;
    }, 30000);

    it('GET /api/docs returns 200 with HTML containing the custom title', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('StreamTube API Docs');
    });

    it('GET /api/docs-json returns 200 with valid OpenAPI JSON', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const doc = res.body as Record<string, unknown>;
      expect((doc.info as Record<string, unknown>).title).toBe(
        'StreamTube API',
      );
      expect(
        (doc.components as Record<string, unknown>)?.securitySchemes as Record<
          string,
          unknown
        >,
      ).toMatchObject({
        'access-token': { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      });
    });

    it('GET /api/docs-yaml returns 200 with YAML content', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-yaml')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/yaml/);
    });
  });

  describe('when SWAGGER_ENABLED is not set', () => {
    let app: INestApplication<App>;
    let module: TestingModule;

    beforeAll(async () => {
      delete process.env.SWAGGER_ENABLED;
      const result = await createApp(false);
      app = result.app;
      module = result.module;
    }, 30000);

    afterAll(async () => {
      if (app) {
        try {
          await app.close();
        } catch {
          // Ignore cleanup errors
        }
      }

      if (module) {
        try {
          await module.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }, 30000);

    it('GET /api/docs returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs').expect(404);
    });

    it('GET /api/docs-json returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
    });

    it('GET /api/docs-yaml returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs-yaml').expect(404);
    });
  });
});
