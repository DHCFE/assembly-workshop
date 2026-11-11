import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:'*.spec.mjs',workers:1,timeout:60_000,
  use:{baseURL:'http://127.0.0.1:8766/',acceptDownloads:true,reducedMotion:'reduce',
    viewport:{width:1280,height:900},launchOptions:{
      ...(process.env.WORKSHOP_TEST_CHROME?{executablePath:process.env.WORKSHOP_TEST_CHROME}:{}),
      args:['--enable-webgl','--enable-unsafe-swiftshader'],
    }},
  webServer:{command:'python3 -m http.server 8766 --bind 127.0.0.1 --directory dist',port:8766,reuseExistingServer:false},
});
