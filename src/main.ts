import 'dotenv/config';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const clientDist = join(process.cwd(), 'client', 'dist');

  if (existsSync(clientDist)) {
    app.useStaticAssets(clientDist);
  }

  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, host);

  console.log(`DiscFlow listening on http://${host}:${port}`);
}

void bootstrap();

