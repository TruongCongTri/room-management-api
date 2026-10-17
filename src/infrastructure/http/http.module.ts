import { Global, Module } from '@nestjs/common';
import { AppHttpClient } from './client/app-http.client';

@Global()
@Module({
  providers: [AppHttpClient],
  exports: [AppHttpClient],
})
export class HttpClientModule {}