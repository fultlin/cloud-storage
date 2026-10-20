import { Test, type TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  it('protects /api by default without a session', () => {
    return request(app.getHttpServer())
      .get('/api')
      .expect(401)
      .expect({ statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' });
  });

  afterEach(async () => {
    await app.close();
  });
});

