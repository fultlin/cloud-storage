import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;

  async function start(swagger: boolean) {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.get(ConfigService).set('SWAGGER_ENABLED', swagger);
    configureApp(app);
    await app.init();
  }

  it('protects /api by default without a session and hides docs when disabled', async () => {
    await start(false);
    await request(app.getHttpServer())
      .get('/api')
      .expect(401)
      .expect({ statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' });
    await request(app.getHttpServer()).get('/api/docs').expect(404);
    await request(app.getHttpServer()).get('/api/docs-json').expect(404);
  });

  it('serves Swagger UI and an OpenAPI document matching the web snapshot', async () => {
    await start(true);
    await request(app.getHttpServer()).get('/api/docs').expect(200).expect('Content-Type', /html/);
    const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const snapshot = readFileSync(new URL('../../web/openapi.json', import.meta.url), 'utf8');
    expect(response.body).toEqual(JSON.parse(snapshot));
  });

  afterEach(async () => {
    await app.close();
  });
});

