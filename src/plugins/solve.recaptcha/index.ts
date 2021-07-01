import axios from 'axios';
import * as path from 'path';
import * as Puppeteer from 'puppeteer';
import { createCursor } from 'ghost-cursor';

import { Plugin } from '../../index';
import { AvoidDetectionPlugin } from './../avoid.detection/index';

const injection = require(path.resolve(`${__dirname}/injections`) + '/utils.js');// tslint:disable-line: no-var-requires
const randomBetween = (min: number, max: number) => Math.floor(Math.random() * (max - min)) + min;

export class SolveRecaptchaPlugin extends Plugin {
  dependencies = [new AvoidDetectionPlugin()];
  witAiAccessToken?: string;

  constructor(witAiAccessToken: string) {
    super();
    this.witAiAccessToken = witAiAccessToken;
  }

  protected async onPageCreated(page: Puppeteer.Page) {
    if (!this.isStopped && !page.isClosed()) await page.evaluateOnNewDocument(injection);
  }

  async hasCaptcha(page: Puppeteer.Page) {
    return page.evaluate(() => !!document.querySelector<HTMLIFrameElement>('iframe[src*="api2/anchor"]')?.contentDocument?.querySelector('#recaptcha-anchor'));
  }

  async solveRecaptcha(page: Puppeteer.Page) {
    if (this.isStopped) return;
    if (!this.witAiAccessToken) return;
    if (!(await this.hasCaptcha(page))) return;

    const cursor = createCursor(page);

    async function waitForSelector(iframeUrlIncludes: string, selector: string) {
      await page.waitForFunction((_iframeUrlIncludes: string, _selector: string) => document.querySelector<HTMLIFrameElement>(`iframe[src*="${_iframeUrlIncludes}"]`)?.contentDocument?.querySelector(_selector), {}, iframeUrlIncludes, selector);
    }

    async function findAndClick(iframeUrlIncludes: string, selector: string) {
      await waitForSelector(iframeUrlIncludes, selector);

      const element = await page.frames().find(frame => frame.url().includes(iframeUrlIncludes))?.$(selector);
      if (!element) return;

      await sleep(randomBetween(1 * 1000, 3 * 1000));
      await cursor.click(element);
    }

    let numTriesLeft = 5;
    async function isFinished() {
      if (--numTriesLeft === 0) return true;
      return page.evaluate(() => !!document.querySelector<HTMLIFrameElement>('iframe[src*="api2/anchor"]')?.contentDocument?.querySelector('.recaptcha-checkbox-checked'));
    }

    await findAndClick('api2/anchor', '#recaptcha-anchor');
    await findAndClick('api2/bframe', '.rc-button-audio');

    while (!(await isFinished())) {
      await waitForSelector('api2/bframe', '.rc-audiochallenge-tdownload-link');

      const audioArray = await page.evaluate(async () => {
        const audioUrl = document.querySelector<HTMLIFrameElement>('iframe[src*="api2/bframe"]')?.contentDocument?.querySelector<HTMLLinkElement>('.rc-audiochallenge-tdownload-link')?.href;

        if (!audioUrl) return null;

        const audioResponse = await fetch(audioUrl, { referrer: '' });
        const audio = await audioResponse.arrayBuffer();

        const _audioBuffer = await (window as any).normalizeAudio(audio);

        const audioSlice = await (window as any).sliceAudio({
          audioBuffer: _audioBuffer,
          start: 1.5,
          end: _audioBuffer.duration - 1.5
        });

        const wav = (window as any).audioBufferToWav(audioSlice);

        return [...new Int8Array(wav)];
      });

      if (!audioArray) return;

      const audioBuffer = Buffer.from(new Int8Array(audioArray));

      const response = await axios.post('https://api.wit.ai/speech?v=20210701', audioBuffer, {
        headers: {
          'Authorization': `Bearer ${this.witAiAccessToken}`,
          'Content-Type': 'audio/wav'
        }
      });

      if (response.data.text) {
        const responseInput = await page.frames().find(frame => frame.url().includes('api2/bframe'))?.$('#audio-response');
        responseInput?.type(response.data.text);

        await findAndClick('api2/bframe', '#recaptcha-verify-button');

        await sleep(1000);
      } else {
        await findAndClick('api2/bframe', '#recaptcha-reload-button');
      }
    }
  }
}

function sleep(timeout: number) {
  return new Promise(resolve => setTimeout(resolve, timeout));
}