// Runs the receiver's main inline script in a vm with fakes for the DOM,
// CAF and hls.js, plus a manual clock, and checks the playback-session logic.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(process.argv[2], 'utf8');
const LANG = process.argv[3] || 'es-ES';
// The page's strings.js (the copy in the app's languages), when there is one.
const STRINGS_SRC = process.argv[4] && fs.existsSync(process.argv[4]) ? fs.readFileSync(process.argv[4], 'utf8') : null;

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: (c, on) => { const v = on === undefined ? !set.has(c) : on; v ? set.add(c) : set.delete(c); return v; },
    contains: (c) => set.has(c),
  };
}
function makeEl(id) {
  const listeners = {};
  return {
    id, textContent: '', innerHTML: '', classList: makeClassList(),
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    fire: (ev) => (listeners[ev] || []).slice().forEach((f) => f({ type: ev })),
    focus() {},
  };
}

// storage: what the TV kept from earlier launches (localStorage); null for a
// TV whose storage throws. lang: the device's own language.
function setup({ storage = {}, lang = LANG } = {}) {
  // ── manual clock ──
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const clock = {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn, every: ms }); return id; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
    now: () => now,
  };

  // ── DOM ──
  const els = {};
  const getEl = (id) => (els[id] = els[id] || makeEl(id));
  const video = Object.assign(makeEl('media'), {
    currentTime: 0, paused: true, readyState: 0, src: '', error: null,
    seekable: { length: 0 }, buffered: { length: 0 },
    duration: NaN, videoWidth: 0, videoHeight: 0, webkitDecodedFrameCount: 0,
    playCalls: 0,
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() { this.error = null; }, removeAttribute(a) { if (a === 'src') this.src = ''; },
    canPlayType: () => '',
  });
  els.media = video;

  // ── hls.js fake ──
  const instances = [];
  class Hls {
    constructor(config) { allInstances.push(this); this.config = config; this.handlers = {}; this.levels = []; this.destroyed = false; this.startLoads = 0; instances.push(this); }
    static isSupported() { return true; }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, data) {
      // Like hls.js, its own code keeps running after the handlers return.
      this.emitting = (this.emitting || 0) + 1;
      try { (this.handlers[ev] || []).forEach((f) => f(ev, data)); }
      finally { this.emitting--; }
      if (this.destroyed) throw new TypeError("Cannot read property 'trigger' of null");
    }
    loadSource(url) { this.url = url; }
    attachMedia(m) { this.media = m; }
    destroy() { if (this.emitting) this.destroyedDuringEmit = true; this.destroyed = true; }
    startLoad() { this.startLoads++; }
  }
  Hls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_SWITCHED: 'hlsLevelSwitched', ERROR: 'hlsError', BUFFER_CODECS: 'hlsBufferCodecs', FRAG_BUFFERED: 'hlsFragBuffered' };
  Hls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  Hls.ErrorDetails = {
    MANIFEST_LOAD_ERROR: 'manifestLoadError', MANIFEST_LOAD_TIMEOUT: 'manifestLoadTimeOut',
    MANIFEST_PARSING_ERROR: 'manifestParsingError', MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'manifestIncompatibleCodecsError',
    LEVEL_EMPTY_ERROR: 'levelEmptyError', LEVEL_LOAD_ERROR: 'levelLoadError', LEVEL_LOAD_TIMEOUT: 'levelLoadTimeOut',
    LEVEL_PARSING_ERROR: 'levelParsingError', FRAG_LOAD_ERROR: 'fragLoadError',
    BUFFER_ADD_CODEC_ERROR: 'bufferAddCodecError', BUFFER_INCOMPATIBLE_CODECS_ERROR: 'bufferIncompatibleCodecsError',
    BUFFER_STALLED_ERROR: 'bufferStalledError', BUFFER_APPEND_ERROR: 'bufferAppendError',
  };

  // ── CAF fake ──
  const interceptors = {};
  const customListeners = {};
  // LOADs the page makes itself (playerManager.load). [cafRoutesOwnLoads]:
  // whether CAF passes them through the LOAD interceptor (undocumented); when
  // it doesn't, CAF gives the element the file itself.
  const loads = [];
  const cafSettings = { routesOwnLoads: true };
  const sent = [];            // {ns, to, msg} from context.sendCustomMessage
  let startOptions = null;
  // What this fake device decodes: MSE types and canDisplayType answers.
  const device = {
    mse: new Set(['video/mp4; codecs="avc1.64001F"', 'video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.640029"', 'audio/mp4; codecs="ac-3"']),
    display: (codecs, w, h, fps) => !(fps > 30 && h >= 1080) && h <= 1080,
  };
  class ErrorData { constructor(type) { this.type = type; } }
  const cast = { framework: {
    CastReceiverContext: { getInstance: () => ({
      getPlayerManager: () => ({
        setMessageInterceptor: (t, fn) => { interceptors[t] = fn; }, broadcastStatus() {},
        getMediaInformation: () => null,
        load: (req) => {
          loads.push(req);
          if (cafSettings.routesOwnLoads) return Promise.resolve(interceptors.LOAD(req));
          video.src = req.media.contentUrl || req.media.contentId;
          return Promise.resolve();
        },
      }),
      start(options) { startOptions = options; },
      addCustomMessageListener: (ns, fn) => { customListeners[ns] = fn; },
      sendCustomMessage: (ns, to, msg) => { sent.push({ ns, to, msg: JSON.parse(JSON.stringify(msg)) }); },
      canDisplayType: (mime, codecs, w, h, fps) => device.display(codecs, w, h, fps),
    }) },
    system: { MessageType: { JSON: 'JSON' } },
    CastReceiverOptions: class {},
    messages: {
      MessageType: { LOAD: 'LOAD', PLAY: 'PLAY', PAUSE: 'PAUSE', SEEK: 'SEEK' },
      StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
      ErrorData, ErrorType: { LOAD_FAILED: 'LOAD_FAILED' }, ErrorReason: { GENERIC_LOAD_ERROR: 'GENERIC_LOAD_ERROR' },
      LoadRequestData: class { constructor() { this.media = null; this.customData = null; } },
      MediaInformation: class {},
      TvShowMediaMetadata: class { constructor() { this.metadataType = 2; } },
      Image: class { constructor(url) { this.url = url; } },
      Command: { ALL_BASIC_MEDIA: 1 },
    },
  } };

  // The provider as the page's fetch() sees it: answer(url) → { status,
  // body (bytes) } or { fails: true } (no CORS headers, network down).
  // readsWhileBusy: reads made while the element still held the file (with a
  // one-connection account the provider refuses them, or cuts the picture).
  const provider = { answer: () => ({ status: 200, body: fixture('h264_aac.mkv') }), fetches: [], readsWhileBusy: 0 };
  const fetch = (url) => {
    provider.fetches.push(url);
    if (video.src) { provider.readsWhileBusy++; readsWhileBusy.n++; }
    const a = provider.answer(url);
    if (a.fails) return Promise.reject(new TypeError('Failed to fetch'));
    const body = a.body || new Uint8Array(0);
    let at = 0;
    return Promise.resolve({
      ok: a.status >= 200 && a.status < 300, status: a.status,
      body: { getReader: () => ({
        read: () => {
          if (at >= body.length) return Promise.resolve({ done: true });
          const value = body.subarray(at, at + 4096); at += 4096;
          return Promise.resolve({ done: false, value });
        },
        cancel() {},
      }) },
    });
  };
  class AbortController { constructor() { this.signal = {}; } abort() { this.aborted = true; } }

  const ctx = {
    fetch, AbortController, Uint8Array,
    console, URL, URLSearchParams, Promise, Date: { now: () => clock.now() },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval,
    document: { getElementById: getEl, documentElement: { lang: 'en', dir: 'ltr' } },
    navigator: { language: lang },
    location: { search: '', pathname: '/caster/staging/' },
    addEventListener() {},
    cast, Hls,
    MediaSource: { isTypeSupported: (t) => device.mse.has(t) },
  };
  Object.defineProperty(ctx, 'localStorage', {
    get() {
      if (storage === null) throw new Error('SecurityError: storage is off');
      return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
      };
    },
  });
  // As in the page's markup: the ready words start hidden.
  getEl('ready-text').classList.add('pending');
  ctx.window = ctx;
  vm.createContext(ctx);
  if (STRINGS_SRC) vm.runInContext(STRINGS_SRC, ctx);
  vm.runInContext(SRC, ctx);
  const ev = (expr) => vm.runInContext(expr, ctx);
  const statuses = () => sent.filter((x) => x.msg.type === 'status').map((x) => x.msg);
  const fromApp = (data, senderId = 'app-1') => customListeners['urn:x-cast:com.nipaplayer.cast']({ senderId, data });
  return { ctx, ev, clock, video, els, instances, interceptors, Hls, sent, statuses, fromApp, device, startOptions: () => startOptions, provider, loads, caf: cafSettings };
}

// The start of a test file (made with ffmpeg from test patterns), as a provider sends it.
function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.head`)));
}

function loadReq(url, { contentType = 'application/x-mpegURL', live = true, features = { resumeV2: true, seekV2: true } } = {}) {
  return { media: { contentUrl: url, contentId: url, contentType, streamType: live ? 'LIVE' : 'BUFFERED' }, currentTime: 0, customData: { sender: 'nipa', appVersion: '1.5.0', platform: 'ios', features } };
}
const err = (details, { fatal = true, type = 'networkError', status, mimeType } = {}) =>
  ({ type, details, fatal, response: status ? { code: status } : undefined, mimeType });
const flush = () => new Promise((r) => setImmediate(r));
const overlay = (env) => ({
  loading: !env.els.loading.classList.contains('hidden'),
  loadingText: env.els['loading-text'].textContent,
  loadingDetail: env.els['loading-detail'].textContent,
  error: !env.els.error.classList.contains('hidden'),
  errorTitle: env.els['error-title'].textContent,
  errorSubtitle: env.els['error-subtitle'].textContent,
  errorCode: env.els['error-code'].textContent,
});
let settled;
function watch(p) { settled = undefined; p.then((v) => { settled = v; }); }

const allInstances = [];
const readsWhileBusy = { n: 0 };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('458 on the manifest: waits with the reason, retries, then plays', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  const h1 = env.instances.at(-1);
  assert.strictEqual(h1.url, 'http://p.example/live/u/p/1.m3u8');
  h1.emit('hlsError', err('manifestLoadError', { status: 458 }));
  let o = overlay(env);
  assert(o.loading && o.loadingText.startsWith('Esperando a tu proveedor'), JSON.stringify(o));
  assert(o.loadingDetail.includes('todas las que permite tu cuenta están en uso'), o.loadingDetail);
  assert.strictEqual(env.ev('hls'), null, 'detached at once');
  assert(!h1.destroyed, 'destroyed only after its callback returned');
  env.clock.advance(0);
  assert(h1.destroyed);
  env.clock.advance(3999); assert.strictEqual(env.instances.length, 1);
  env.clock.advance(1); assert.strictEqual(env.instances.length, 2, 'retry #1 after 4 s');
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 458 }));
  env.clock.advance(6000); assert.strictEqual(env.instances.length, 3, 'retry #2 after 6 s');
  env.clock.advance(10000); // 20 s optimistic settle passes during the wait
  await flush();
  assert(settled && settled.media, 'LOAD resolved optimistically, session kept');
  const h3 = env.instances.at(-1);
  h3.emit('hlsManifestParsed', { levels: [{}] });
  assert.strictEqual(env.ev('session.slotWaitStartedAt'), 0);
  env.video.fire('playing');
  assert(env.ev('session.hasPlayed'));
});

test('458 for longer than 3 min ends on the account-busy screen', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  for (let i = 0; i < 40 && !overlay(env).error; i++) {
    env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 458 }));
    env.clock.advance(15000);
  }
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'Las conexiones de tu cuenta están todas en uso', JSON.stringify(o));
  assert(o.errorCode.includes('458'));
  const tries = env.instances.length;
  assert(tries >= 12 && tries <= 20, `retries ${tries}`);
});

test('404 on the manifest: "no longer on your provider\'s server" and LOAD_FAILED', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 404 }));
  await flush();
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'Ya no está en el servidor de tu proveedor' && o.errorCode.includes('404'), JSON.stringify(o));
  assert(settled && settled.media, 'sender without loadFailure: the LOAD succeeds, the TV explains');
});

test('403 on the manifest: provider refused', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 403 }));
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'Tu proveedor no deja reproducir esto en la tele', JSON.stringify(o));
});

test('no status (CORS/network): rebuilds, then "can\'t reach your provider"', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  for (let i = 0; i < 4; i++) {
    env.instances.at(-1).emit('hlsError', err('manifestLoadError', {}));
    env.clock.advance(1000);
  }
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'La tele no consigue conectar con tu proveedor', JSON.stringify(o));
  assert.strictEqual(env.instances.length, 4, '1 + 3 rebuilds');
});

test('codec refused (1080p50, level 4.2): codec screen naming the format', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  const h = env.instances.at(-1);
  h.emit('hlsManifestParsed', { levels: [{}] });
  h.emit('hlsError', err('bufferAddCodecError', { fatal: false, type: 'mediaError', mimeType: 'video/mp4;codecs=avc1.4d402a' }));
  await flush();
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'Esta tele no puede reproducir este canal', JSON.stringify(o));
  assert(o.errorSubtitle.includes('1080p a 50/60 fps (H.264 nivel 4.2)'), o.errorSubtitle);
  assert(settled && settled.media, 'sender without loadFailure: the LOAD succeeds, the TV explains');
  // A late incompatible-codecs error from the same instance is ignored.
  h.emit('hlsError', err('bufferIncompatibleCodecsError', { type: 'mediaError' }));
});

test('live .ts: plays its .m3u8 and presents the request as HLS to CAF', async () => {
  const env = setup();
  const req = loadReq('http://p.example/live/u/p/7.ts', { contentType: 'video/mp2t' });
  watch(env.interceptors.LOAD(req));
  const h = env.instances.at(-1);
  assert.strictEqual(h.url, 'http://p.example/live/u/p/7.m3u8');
  assert.strictEqual(req.media.contentType, 'application/x-mpegurl');
  assert.strictEqual(req.media.contentUrl, 'http://p.example/live/u/p/7.m3u8');
  h.emit('hlsManifestParsed', { levels: [{}] });
  env.video.fire('playing');
  await flush();
  assert(settled === req);
});

test('live .ts without HLS: falls back to the .ts, restores the request', async () => {
  const env = setup();
  const req = loadReq('http://p.example/live/u/p/7.ts?x=1', { contentType: 'video/mp2t' });
  watch(env.interceptors.LOAD(req));
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 404 }));
  await flush();
  assert(settled === req, 'CAF gets the original request back');
  assert.strictEqual(req.media.contentUrl, 'http://p.example/live/u/p/7.ts?x=1');
  assert.strictEqual(req.media.contentType, 'video/mp2t');
  // The device can't play it: MediaError → MPEG-TS screen.
  env.video.error = { code: 4 };
  env.video.fire('error');
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'Este canal no se puede enviar', JSON.stringify(o));
});

test('catch-up .ts is not rewritten', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/timeshift/u/p/60/2026-10-21:10-00/7.ts', { contentType: 'video/mp2t' })));
  assert.strictEqual(env.instances.length, 0, 'native engine, not hls.js');
});

test('media error after playing: rebuild, not a silent freeze', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  const h = env.instances.at(-1);
  h.levels = [{}];
  h.emit('hlsManifestParsed', { levels: [{}] });
  env.video.fire('playing');
  h.emit('hlsError', err('bufferStalledError', { type: 'mediaError' }));
  assert(overlay(env).loadingText === 'Reconectando...', JSON.stringify(overlay(env)));
  env.clock.advance(1000);
  assert.strictEqual(env.instances.length, 2);
  assert(h.destroyed);
});

test('non-fatal stall: no startLoad()', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  const h = env.instances.at(-1);
  h.emit('hlsError', err('bufferStalledError', { fatal: false, type: 'mediaError' }));
  assert.strictEqual(h.startLoads, 0);
});

test('watchdog: frozen while meant to play → rebuild; user pause respected', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  const h = env.instances.at(-1);
  h.emit('hlsManifestParsed', { levels: [{}] });
  env.video.currentTime = 10; env.video.paused = false; env.video.readyState = 4;
  env.video.fire('playing');
  env.clock.advance(5000);
  // user pauses: no rebuild however long
  env.interceptors.PAUSE({});
  env.clock.advance(60000);
  assert.strictEqual(env.instances.length, 1, 'no rebuild while the user paused');
  env.interceptors.PLAY({});
  env.clock.advance(24000);
  assert.strictEqual(env.instances.length, 1, 'not yet: under 25 s without progress');
  env.clock.advance(8000);
  assert.strictEqual(env.instances.length, 2, 'frozen → rebuilt');
});

test('watchdog: paused without the user → play()', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  env.instances.at(-1).emit('hlsManifestParsed', { levels: [{}] });
  env.video.fire('playing');
  env.video.paused = true; env.video.readyState = 4;
  const before = env.video.playCalls;
  env.clock.advance(5000);
  assert(env.video.playCalls > before);
});

test('never starts (manifest ok, no picture) → rebuilds, then error', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  env.instances.at(-1).emit('hlsManifestParsed', { levels: [{}] });
  env.clock.advance(5 * 60000);
  const o = overlay(env);
  assert(o.error && o.errorCode === 'NO PLAYBACK', JSON.stringify(o));
  assert.strictEqual(env.instances.length, 4);
});

test('no readable video track (MPEG-2/HEVC in TS): sound-only notice, cleared on the next LOAD', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/686.m3u8')));
  const h = env.instances.at(-1);
  h.emit('hlsManifestParsed', { levels: [{}] });
  h.emit('hlsBufferCodecs', { audio: { codec: 'mp4a.40.2' } });
  assert(!env.els.notice.classList.contains('hidden'), 'notice shown');
  assert(env.els.notice.textContent.startsWith('Solo se reproduce el sonido'));
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  assert(env.els.notice.classList.contains('hidden'), 'notice hidden on the next LOAD');
  env.instances.at(-1).emit('hlsBufferCodecs', { audio: {}, video: {} });
  assert(env.els.notice.classList.contains('hidden'), 'no notice with video');
});

const ranges = (...r) => ({ length: r.length, start: (i) => r[i][0], end: (i) => r[i][1] });
test('fragments buffered but nothing playable (1080i fields): undecodable after two', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/21043.m3u8')));
  const h = env.instances.at(-1);
  h.bufferController = { sourceBuffer: { video: { buffered: ranges() } } };
  h.emit('hlsManifestParsed', { levels: [{}] });
  h.emit('hlsFragBuffered', { frag: { type: 'main', sn: 199 } });
  assert(!overlay(env).error, 'one empty fragment is not enough');
  h.emit('hlsFragBuffered', { frag: { type: 'audio', sn: 1 } });
  assert(!overlay(env).error, 'audio fragments do not count');
  h.emit('hlsFragBuffered', { frag: { type: 'main', sn: 200 } });
  await flush();
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'Esta tele no puede reproducir este canal', JSON.stringify(o));
  assert(o.errorSubtitle.includes('1080i entrelazado'));
  assert(settled && settled.media, 'sender without loadFailure: the LOAD succeeds, the TV explains');
  env.clock.advance(0);
  assert(h.destroyed);
});

test('video buffered while audio lags: not undecodable', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  const h = env.instances.at(-1);
  h.bufferController = { sourceBuffer: { video: { buffered: ranges([10, 20]) }, audio: { buffered: ranges() } } };
  env.video.buffered = ranges(); // intersection empty
  for (let i = 0; i < 4; i++) h.emit('hlsFragBuffered', { frag: { type: 'main', sn: i } });
  assert(!overlay(env).error, JSON.stringify(overlay(env)));
});

test('radio (audio-only SourceBuffer with data): not undecodable', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/radio.m3u8')));
  const h = env.instances.at(-1);
  h.bufferController = { sourceBuffer: { audio: { buffered: ranges([0, 10]) } } };
  env.video.buffered = ranges([0, 10]);
  for (let i = 0; i < 4; i++) h.emit('hlsFragBuffered', { frag: { type: 'main', sn: i } });
  assert(!overlay(env).error);
});

const NEW_SENDER = { resumeV2: true, seekV2: true, loadFailure: true };
test('sender with loadFailure: 404 fails the LOAD', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8', { features: NEW_SENDER })));
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 404 }));
  await flush();
  assert(settled && settled.type === 'LOAD_FAILED');
  assert(overlay(env).error);
});

test('sender with loadFailure: codec and undecodable fail the LOAD', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/2.m3u8', { features: NEW_SENDER })));
  env.instances.at(-1).emit('hlsError', err('bufferAddCodecError', { fatal: false, type: 'mediaError', mimeType: 'video/mp4;codecs=avc1.4d402a' }));
  await flush();
  assert(settled && settled.type === 'LOAD_FAILED');
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/3.m3u8', { features: NEW_SENDER })));
  const h = env.instances.at(-1);
  h.bufferController = { sourceBuffer: { video: { buffered: ranges() } } };
  h.emit('hlsFragBuffered', { frag: { type: 'main', sn: 1 } });
  h.emit('hlsFragBuffered', { frag: { type: 'main', sn: 2 } });
  await flush();
  assert(settled && settled.type === 'LOAD_FAILED');
});

test('legacy sender: a failed channel keeps the session, the next channel plays', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/233969.m3u8')));
  env.instances.at(-1).emit('hlsError', err('bufferAddCodecError', { fatal: false, type: 'mediaError', mimeType: 'video/mp4;codecs=avc1.4d402a' }));
  await flush();
  assert(settled && settled.media && overlay(env).error);
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/653.m3u8')));
  assert(!overlay(env).error, 'error cleared by the new LOAD');
  const h = env.instances.at(-1);
  h.emit('hlsManifestParsed', { levels: [{}] });
  env.video.fire('playing');
  await flush();
  assert(settled && settled.media && settled.media.contentUrl.endsWith('/653.m3u8'));
});

test('a new LOAD cancels the previous session and its retries', async () => {
  const env = setup();
  const p1 = env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8'));
  let r1; p1.then((v) => { r1 = v; });
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 458 }));
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/2.m3u8')));
  await flush();
  assert(r1 && r1.media, 'previous LOAD settled, CAF never left waiting');
  const count = env.instances.length;
  env.clock.advance(20000);
  assert(env.instances.slice(count).every((h) => !h.url.endsWith('/1.m3u8')), 'no late retry of the old channel');
});

test('Retry after the one-device screen starts a fresh wait', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  for (let i = 0; i < 40 && !overlay(env).error; i++) {
    env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 458 }));
    env.clock.advance(15000);
  }
  assert(overlay(env).error);
  const n = env.instances.length;
  env.els['error-retry'].fire('click');
  assert.strictEqual(env.instances.length, n + 1);
  assert.strictEqual(env.instances.at(-1).url, 'http://p.example/live/u/p/1.m3u8');
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 458 }));
  assert(overlay(env).loadingText.startsWith('Esperando'));
});

test('a stream that plays, freezes, and recovers keeps being rebuilt over time', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  for (let round = 0; round < 5; round++) {
    const h = env.instances.at(-1);
    h.emit('hlsManifestParsed', { levels: [{}] });
    env.video.paused = false;
    env.video.currentTime += 50;
    env.video.fire('playing');
    env.clock.advance(5000);           // progress seen
    env.clock.advance(40000);          // then frozen → one rebuild, slow to restart
  }
  assert(!env.ev("session.failed"), "session still alive");
  assert(!overlay(env).error, "rebuilds spread over time are not capped");
  assert.strictEqual(env.instances.length, 6, 'one rebuild per freeze');
});

// ── Status channel (protocol v1) ──

const NIPA = { resumeV2: true, seekV2: true, nipaStatus: true };
function nipaReq(url, loadId, extra = {}) {
  const r = loadReq(url, { features: NIPA, ...extra });
  r.customData.nipa = { v: 1, loadId, locale: 'en-GB' };
  return r;
}
const last = (env) => env.statuses().at(-1);

test('hello: the receiver answers with its version and what the device decodes', async () => {
  const env = setup();
  assert.deepStrictEqual(Object.keys(env.startOptions().customNamespaces), ['urn:x-cast:com.nipaplayer.cast']);
  env.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'es-ES' });
  const hello = env.sent.find((x) => x.msg.type === 'hello');
  assert(hello && hello.to === 'app-1', 'answered to that app');
  assert.strictEqual(hello.msg.v, 1);
  assert(/^\d{4}-\d{2}-\d{2}\.\d+$/.test(hello.msg.rx), hello.msg.rx);
  const caps = hello.msg.caps;
  assert.strictEqual(caps.h264MaxLevel, '4.1', 'like a 2nd-gen Chromecast');
  assert.strictEqual(caps.fhd60, false);
  assert.strictEqual(caps.hevc, false);
  assert.strictEqual(caps.ac3, true);
  assert.strictEqual(caps.eac3, false);
  assert.deepStrictEqual(caps.tsVideo, ['h264']);
});

test('status-channel app: LOAD resolved at once; starting → buffering → playing, with its load id', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(nipaReq('http://p.example/live/u/p/1.m3u8', 'L1')));
  await flush();
  assert(settled && settled.media, 'resolved before any picture');
  assert.strictEqual(last(env).state, 'starting');
  env.instances.at(-1).emit('hlsManifestParsed', { levels: [{ videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2' }] });
  assert.strictEqual(last(env).state, 'buffering');
  env.video.videoWidth = 1280; env.video.videoHeight = 720;
  env.video.fire('playing');
  const st = last(env);
  assert.strictEqual(st.state, 'playing');
  assert.strictEqual(st.loadId, 'L1');
  assert.deepStrictEqual(st.stream.video, { w: 1280, h: 720, codec: 'avc1.640028' });
  assert.strictEqual(st.stream.via, 'm3u8');
  const seqs = env.statuses().map((x) => x.seq);
  assert(seqs.every((v, i) => i === 0 || v > seqs[i - 1]), 'seq increases');
  assert(!overlay(env).loading, 'the picture is up');
});

test('status-channel app: a busy provider is a wait, with how long and when it gives up', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(nipaReq('http://p.example/live/u/p/1.m3u8', 'L2')));
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 458 }));
  let st = last(env);
  assert.strictEqual(st.state, 'waitingSlot');
  assert.strictEqual(st.wait.http, 458);
  assert.strictEqual(st.wait.attempts, 0);
  assert(st.wait.giveUpInMs > 170000);
  env.clock.advance(5000);                       // heartbeat during the wait
  st = last(env);
  assert.strictEqual(st.state, 'waitingSlot');
  assert(st.wait.sinceMs >= 5000, 'the heartbeat refreshes the wait');
  env.instances.at(-1).emit('hlsManifestParsed', { levels: [{}] });
  env.video.fire('playing');
  assert.strictEqual(last(env).state, 'playing');
  assert(!last(env).wait, 'the wait is over');
});

test('status-channel app: failures carry their kind and never fail the LOAD', async () => {
  const cases = [
    [(h) => h.emit('hlsError', err('manifestLoadError', { status: 404 })), { kind: 'notFound', http: 404 }],
    [(h) => h.emit('hlsError', err('manifestLoadError', { status: 403 })), { kind: 'auth', http: 403 }],
    [(h) => h.emit('hlsError', err('bufferAddCodecError', { fatal: false, type: 'mediaError', mimeType: 'video/mp4;codecs=avc1.4d402a' })),
      { kind: 'codec', detail: 'video/mp4;codecs=avc1.4d402a' }],
  ];
  for (const [fail, want] of cases) {
    const env = setup();
    watch(env.interceptors.LOAD(nipaReq('http://p.example/live/u/p/1.m3u8', 'L3')));
    fail(env.instances.at(-1));
    await flush();
    assert(settled && settled.media && settled.type !== 'LOAD_FAILED', 'resolved, not LOAD_FAILED');
    const st = last(env);
    assert.strictEqual(st.state, 'failed');
    assert.deepStrictEqual(st.failure, want);
    assert(overlay(env).error, 'the TV explains too');
  }
});

test('status-channel app: frozen and never-started name themselves, with their own TV copy', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(nipaReq('http://p.example/live/u/p/1.m3u8', 'L4')));
  for (let i = 0; i < 4; i++) env.clock.advance(50000);
  const st = last(env);
  assert.strictEqual(st.state, 'failed');
  assert.strictEqual(st.failure.kind, 'noPlayback');
  assert.strictEqual(overlay(env).errorTitle, 'The picture froze', 'in the app\'s language (en-GB)');
});

test("the app's language: every one of them, right to left where it's written so", async () => {
  const env = setup();
  const root = env.ctx.document.documentElement;
  const langs = Object.keys(env.ev('STRINGS'));
  assert(langs.length >= 28, `languages ${langs.length}`);
  env.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'ar' });
  assert.strictEqual(root.dir, 'rtl');
  assert.strictEqual(root.lang, 'ar');
  assert.notStrictEqual(env.els['ready-title'].textContent, 'Ready to cast', 'the ready screen follows');
  env.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'android', locale: 'no-NO' });
  assert.strictEqual(root.lang, 'nb');
  assert.strictEqual(root.dir, 'ltr');
  env.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'pt-BR' });
  assert.strictEqual(root.lang, 'pt');
  env.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'xx' });
  assert.strictEqual(root.lang, 'en');
  env.clock.advance(1000);
  assert.strictEqual(env.els['ready-title'].textContent, 'Ready to cast', 'a fade that never ends still swaps');
});

test('the ready words: only ever shown in the app\'s language, whatever the TV kept', async () => {
  const STR = (lang) => setup().ev('STRINGS')[lang];
  const words = (env) => env.els['ready-text'].classList.contains('pending') ? null : env.els['ready-title'].textContent;
  // First launch on this TV (an English one): nothing kept, the words wait.
  const kept = {};
  const first = setup({ storage: kept, lang: 'en-GB' });
  assert.strictEqual(words(first), null, 'hidden until the app says');
  first.clock.advance(300);
  first.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'es-ES' });
  assert.strictEqual(words(first), STR('es').readyTitle, 'straight in Spanish');
  assert.strictEqual(kept['nipa.lang'], 'es');
  // Next launch, the app now in Arabic: the kept Spanish is never shown.
  const next = setup({ storage: kept, lang: 'en-GB' });
  assert.strictEqual(words(next), null, 'waits for the app even with a language kept');
  next.clock.advance(300);
  next.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'ar' });
  assert.strictEqual(words(next), STR('ar').readyTitle, 'straight in Arabic');
  assert.strictEqual(kept['nipa.lang'], 'ar');
  // Another phone in German joins later: the words fade out, swap, and come back.
  next.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'android', locale: 'de-DE' });
  assert.strictEqual(words(next), null, 'fading out');
  next.clock.advance(500);
  assert.strictEqual(next.els['ready-title'].textContent, STR('ar').readyTitle, 'not swapped before the fade ends');
  next.els['ready-text'].fire('transitionend');
  assert.strictEqual(words(next), STR('de').readyTitle);
  assert.strictEqual(kept['nipa.lang'], 'de');
  // An app that doesn't say in time: the kept language, after a moment...
  const late = setup({ storage: { 'nipa.lang': 'pl' }, lang: 'en-GB' });
  late.clock.advance(1900);
  assert.strictEqual(words(late), null);
  late.clock.advance(200);
  assert.strictEqual(words(late), STR('pl').readyTitle);
  // ...or with none kept (an old version, never), the device's.
  const silent = setup({ storage: {}, lang: 'fr-FR' });
  silent.clock.advance(1900);
  assert.strictEqual(words(silent), null);
  silent.clock.advance(200);
  assert.strictEqual(words(silent), STR('fr').readyTitle);
  // Its LOAD without a locale isn't kept; one with a locale is.
  const s2 = {};
  const legacy = setup({ storage: s2 });
  legacy.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8'));
  assert.strictEqual(s2['nipa.lang'], undefined);
  legacy.interceptors.LOAD(nipaReq('http://p.example/live/u/p/1.m3u8', 'K'));
  assert.strictEqual(s2['nipa.lang'], 'en');
  // Storage off: still works, just waits for the app every time.
  const off = setup({ storage: null, lang: 'en-GB' });
  assert.strictEqual(words(off), null);
  off.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'it' });
  assert.strictEqual(words(off), STR('it').readyTitle);
});

test('status: an app that joins mid-channel gets the current state; a new LOAD has its own id', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(nipaReq('http://p.example/live/u/p/1.m3u8', 'A')));
  env.instances.at(-1).emit('hlsError', err('manifestLoadError', { status: 458 }));
  env.fromApp({ type: 'hello', v: 1 }, 'app-2');
  const toNew = env.sent.filter((x) => x.to === 'app-2').map((x) => x.msg);
  assert.strictEqual(toNew.length, 2, 'hello + current status');
  assert.strictEqual(toNew[1].state, 'waitingSlot');
  assert.strictEqual(toNew[1].loadId, 'A');
  watch(env.interceptors.LOAD(nipaReq('http://p.example/live/u/p/2.m3u8', 'B')));
  assert.strictEqual(last(env).loadId, 'B');
  assert.strictEqual(last(env).state, 'starting');
  env.clock.advance(20000);
  assert(env.statuses().filter((x) => x.loadId === 'A').every((x) => x.seq < last(env).seq), 'nothing more about A');
});

test('status: live .ts goes out as its .m3u8 and says so; no URL in any message', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(nipaReq('http://p.example/live/user/secret/9.ts', 'T', { contentType: 'video/mp2t' })));
  env.instances.at(-1).emit('hlsManifestParsed', { levels: [{}] });
  env.instances.at(-1).emit('hlsBufferCodecs', { video: { codec: 'avc1.64001f' }, audio: { codec: 'mp4a.40.2' } });
  env.video.fire('playing');
  assert.strictEqual(last(env).stream.via, 'ts-sibling');
  assert.strictEqual(last(env).stream.video.codec, 'avc1.64001f', 'from the demuxer when the playlist says nothing');
  const all = JSON.stringify(env.sent);
  assert(!/secret|p\.example|http/i.test(all), 'no URL or credential leaves the TV');
});

test('legacy app: no load id, LOAD semantics unchanged (resolved on the first picture)', async () => {
  const env = setup();
  watch(env.interceptors.LOAD(loadReq('http://p.example/live/u/p/1.m3u8')));
  await flush();
  assert.strictEqual(settled, undefined, 'still pending, as before');
  assert.strictEqual(last(env).loadId, null);
  env.instances.at(-1).emit('hlsManifestParsed', { levels: [{}] });
  env.video.fire('playing');
  await flush();
  assert(settled && settled.media);
});


// ── Movies and episodes (native engine) ──

function vodReq(url, loadId, { start = 0, features = NIPA, contentType = 'video/x-matroska' } = {}) {
  const r = loadReq(url, { contentType, live: false, features });
  r.currentTime = start;
  if (loadId) r.customData.nipa = { v: 1, loadId, locale: 'en-GB' };
  return r;
}
// A native LOAD as CAF runs it: the interceptor, then the file into the element.
function loadVod(env, req) {
  const p = env.interceptors.LOAD(req);
  env.video.src = req.media.contentUrl;
  watch(Promise.resolve(p));
  return p;
}
const mediaError = (env, code = 4, message = '') => { env.video.error = { code, message }; env.video.fire('error'); };
const playFor = (env, seconds) => { env.video.paused = false; env.video.currentTime += seconds; env.video.fire('playing'); };

test('movie, account busy (458): waits, asks again, reloads through CAF from the resume point, plays', async () => {
  const env = setup();
  env.provider.answer = () => ({ status: 458 });
  loadVod(env, vodReq('http://p.example/movie/u/p/1.mkv', 'M1', { start: 120 }));
  await flush();
  assert(settled && settled.media, 'resolved at once: CAF loads the file');
  assert.strictEqual(last(env).state, 'starting');
  mediaError(env);
  await flush();
  let st = last(env);
  assert.strictEqual(st.state, 'waitingSlot', JSON.stringify(st));
  assert.strictEqual(st.wait.http, 458);
  assert.strictEqual(overlay(env).loadingText, 'Waiting for your provider…');
  assert.strictEqual(env.video.src, '', 'the element let go of the connection first');
  env.clock.advance(4000); await flush();
  assert.strictEqual(env.provider.fetches.length, 2, 'asked again after 4 s');
  assert.strictEqual(env.loads.length, 0, 'no reload while it still refuses');
  env.provider.answer = () => ({ status: 200, body: fixture('h264_aac.mkv') });
  env.clock.advance(6000); await flush();
  assert.strictEqual(env.loads.length, 1, 'reloaded through CAF once free');
  const r = env.loads[0];
  assert.strictEqual(r.currentTime, 120, 'from where the user resumes');
  assert(r.customData.nipaInternal, 'marked as the receiver\'s own');
  assert.strictEqual(r.media.contentUrl, 'http://p.example/movie/u/p/1.mkv');
  assert.strictEqual(env.ev('session.loadId'), 'M1', 'the same session, not a new LOAD');
  env.video.fire('loadedmetadata');
  st = last(env);
  assert.strictEqual(st.state, 'buffering');
  assert(!st.wait, 'the wait is over');
  playFor(env, 1);
  assert.strictEqual(last(env).state, 'playing');
});

test('movie, account busy with an older app: the account screen at once, no reload', async () => {
  const env = setup();
  env.provider.answer = () => ({ status: 458 });
  watch(env.interceptors.LOAD(loadReq('http://p.example/movie/u/p/1.mkv', { contentType: 'video/x-matroska', live: false })));
  mediaError(env);
  await flush();
  const o = overlay(env);
  assert(o.error && o.errorTitle === 'Las conexiones de tu cuenta están todas en uso', JSON.stringify(o));
  assert.strictEqual(env.loads.length, 0);
});

test('movie with AAC 5.1: fails after the metadata, names the sound, and the TV keeps it in mind', async () => {
  const storage = {};
  const env = setup({ storage });
  env.provider.answer = () => ({ status: 200, body: fixture('aac51.mkv') });
  loadVod(env, vodReq('http://p.example/movie/u/secret/2.mkv', 'M2'));
  env.video.fire('loadedmetadata');
  mediaError(env, 4, 'PIPELINE_ERROR_INITIALIZATION_FAILED');
  await flush();
  const st = last(env);
  assert.strictEqual(st.state, 'failed');
  assert.deepStrictEqual(st.failure, { kind: 'codec', format: { part: 'audio', name: 'AAC 5.1' } });
  const o = overlay(env);
  assert.strictEqual(o.errorTitle, "This TV can't play this video");
  assert(o.errorSubtitle.startsWith('Its sound is in AAC 5.1, which'), o.errorSubtitle);
  assert.strictEqual(JSON.parse(storage['nipa.caps.learned']).aacMulti, false);
  env.fromApp({ type: 'hello', v: 1 });
  const hello = env.sent.filter((x) => x.msg.type === 'hello').at(-1).msg;
  assert.strictEqual(hello.caps.aacMulti, false, 'the next hello says it');
  assert.deepStrictEqual(hello.features, { vodCauses: 1, queue: 1 });
  assert(!/secret|p\.example|http/i.test(JSON.stringify(env.sent)), 'no URL leaves the TV');
});

test('an older app: sound over black is said over the sound after 3 s, never stopped', async () => {
  const env = setup();
  env.provider.answer = () => ({ status: 200, body: fixture('hevc10.mkv') });
  loadVod(env, vodReq('http://p.example/movie/u/p/3.mkv', 'M3', { features: { resumeV2: true, seekV2: true } }));
  env.video.fire('loadedmetadata');
  assert(env.video.src, 'not stopped at the metadata for an app that can\'t follow a reload');
  playFor(env, 1);
  env.clock.advance(3000); await flush();
  assert(!env.els.notice.classList.contains('hidden'), 'the sound-only notice');
  assert.strictEqual(env.provider.fetches.length, 0, 'nothing read: it keeps playing');
});

test('no picture size in the metadata: stopped before any sound, then named', async () => {
  const env = setup();
  env.provider.answer = () => ({ status: 200, body: fixture('hevc10.mkv') });
  loadVod(env, vodReq('http://p.example/movie/u/p/13.mkv', 'M13'));
  env.video.fire('loadedmetadata');
  assert.strictEqual(env.video.src, '', 'stopped at the metadata, before playing');
  await flush();
  assert.deepStrictEqual(last(env).failure.format, { part: 'video', name: 'HEVC (H.265), 10-bit' });
  assert(!env.statuses().some((x) => x.state === 'playing'), 'never played');
  assert.strictEqual(overlay(env).errorTitle, "This TV can't play this video");
});

test('no picture size, sound-only file: reloaded once and left playing', async () => {
  const env = setup();
  env.provider.answer = () => ({ status: 200, body: fixture('audio_only.mkv') });
  loadVod(env, vodReq('http://p.example/music/u/p/14.mkv', 'M14'));
  env.video.fire('loadedmetadata');
  await flush();
  assert.strictEqual(env.loads.length, 1, 'reloaded');
  env.video.fire('loadedmetadata');
  playFor(env, 1);
  env.clock.advance(5000); await flush();
  assert.strictEqual(env.loads.length, 1, 'not again');
  assert(!overlay(env).error);
});

test('Xvid AVI (served as .mp4): named MPEG-4 Part 2', async () => {
  const env = setup();
  env.provider.answer = () => ({ status: 200, body: fixture('xvid.avi') });
  loadVod(env, vodReq('http://p.example/movie/u/p/4.mp4', 'M4', { contentType: 'video/mp4' }));
  env.video.fire('loadedmetadata');
  await flush();
  assert.deepStrictEqual(last(env).failure.format, { part: 'video', name: 'MPEG-4 Part 2 (Xvid/DivX)' });
});

test('a picture: nothing is checked, nothing is read', async () => {
  const env = setup();
  loadVod(env, vodReq('http://p.example/movie/u/p/5.mkv', 'M5'));
  env.video.videoWidth = 1280; env.video.videoHeight = 720; env.video.webkitDecodedFrameCount = 30;
  env.video.fire('loadedmetadata');
  playFor(env, 1);
  env.clock.advance(10000); await flush();
  assert.strictEqual(env.provider.fetches.length, 0);
  assert.strictEqual(last(env).state, 'playing');
});

test('the provider sends a page (HTTP 200, HTML): "a page instead of the video"', async () => {
  const env = setup();
  env.provider.answer = () => ({ status: 200, body: fixture('provider_page.html') });
  loadVod(env, vodReq('http://p.example/movie/u/p/7.mkv', 'M7'));
  mediaError(env);
  await flush();
  assert.strictEqual(last(env).failure.kind, 'notVideo');
  assert.strictEqual(overlay(env).errorTitle, 'Your provider sent a page instead of the video');
});

test('404 and 403 on a movie: their own screens', async () => {
  for (const [status, kind, title] of [[404, 'notFound', "It's no longer on your provider's server"], [403, 'auth', 'Your provider refused to play this on the TV']]) {
    const env = setup();
    env.provider.answer = () => ({ status });
    loadVod(env, vodReq('http://p.example/movie/u/p/8.mkv', 'M8'));
    mediaError(env);
    await flush();
    assert.deepStrictEqual(last(env).failure, { kind, http: status });
    assert.strictEqual(overlay(env).errorTitle, title);
  }
});

test("a provider that can't be read (no CORS): three reloads, then the generic screen", async () => {
  const env = setup();
  env.provider.answer = () => ({ fails: true });
  loadVod(env, vodReq('http://p.example/movie/u/p/9.mkv', 'M9'));
  for (let i = 1; i <= 3; i++) {
    mediaError(env);
    await flush();
    assert.strictEqual(overlay(env).loadingText, 'Retrying...');
    env.clock.advance(4000 * i); await flush();
    assert.strictEqual(env.loads.length, i, `reload #${i}`);
  }
  mediaError(env);
  await flush();
  assert.strictEqual(last(env).state, 'failed');
  assert.strictEqual(last(env).failure.kind, 'media');
  assert.strictEqual(overlay(env).errorTitle, "The TV couldn't play this");
});

test('slow to open: says so after 12 s; then plays, or fails after 2 min', async () => {
  const env = setup();
  loadVod(env, vodReq('http://p.example/movie/u/p/10.mp4', 'M10', { contentType: 'video/mp4' }));
  env.clock.advance(11999);
  assert.notStrictEqual(overlay(env).loadingText, 'Taking longer than usual…');
  env.clock.advance(1);
  assert.strictEqual(overlay(env).loadingText, 'Taking longer than usual…');
  assert(overlay(env).loadingDetail.includes('start on its own'));
  assert.strictEqual(last(env).slow, true);
  env.clock.advance(20000);
  env.video.fire('loadedmetadata');
  assert.strictEqual(last(env).slow, undefined, 'no longer slow');
  assert.strictEqual(last(env).state, 'buffering');

  const never = setup();
  never.provider.answer = () => ({ status: 200, body: fixture('index_at_end.mp4') });
  loadVod(never, vodReq('http://p.example/movie/u/p/11.mp4', 'M11', { contentType: 'video/mp4' }));
  never.clock.advance(120000); await flush();
  assert.strictEqual(last(never).state, 'failed');
  assert.strictEqual(last(never).failure.kind, 'noPlayback');
});

test('broke after playing: reloads where it was', async () => {
  const env = setup();
  loadVod(env, vodReq('http://p.example/movie/u/p/12.mkv', 'M12'));
  env.video.videoWidth = 1280; env.video.webkitDecodedFrameCount = 10;
  env.video.fire('loadedmetadata');
  playFor(env, 500);
  env.video.fire('timeupdate');
  mediaError(env, 2);
  await flush();
  assert.strictEqual(last(env).state, 'reconnecting');
  env.clock.advance(1000); await flush();
  assert.strictEqual(env.loads.length, 1);
  assert.strictEqual(env.loads[0].currentTime, 500);
});

// ── Episode queue ──

const ep = (n, extra = {}) => Object.assign({
  loadId: `E${n}`, url: `http://p.example/series/u/secret/${100 + n}.mkv`, contentType: 'video/x-matroska',
  title: `Episode ${n}`, seriesTitle: 'Show', season: 1, episode: n, imageUrl: `http://img.example/${n}.jpg`, start: 0,
}, extra);
const queueStates = (env, to) => env.sent.filter((x) => x.msg.type === 'queue' && (!to || x.to === to)).map((x) => x.msg);
function startEpisode(env, loadId = 'E1') {
  loadVod(env, vodReq(`http://p.example/series/u/secret/${loadId}.mkv`, loadId));
  env.video.videoWidth = 1280; env.video.webkitDecodedFrameCount = 10;
  env.video.fire('loadedmetadata');
  env.video.duration = 2400;      // credits window: 3% = 72 s
  env.video.currentTime = 0;
  playFor(env, 1);
}
const at = (env, seconds) => { env.video.currentTime = seconds; env.video.fire('timeupdate'); };

test('queue: at the credits, an 8 s count, then the TV loads the next episode itself, with its own id and the rest', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', autoAdvance: true, items: [ep(2, { start: 30 }), ep(3)] });
  assert.deepStrictEqual(last(env).queue, { left: 2, auto: true, cancelled: false });
  at(env, 2327);
  assert(env.els.upnext.classList.contains('hidden'), 'not yet: 73 s left');
  at(env, 2328);
  assert(!env.els.upnext.classList.contains('hidden'), 'the card');
  assert.strictEqual(env.els['upnext-title'].textContent, 'S1 · E2 — Episode 2');
  assert.strictEqual(env.els['upnext-count'].textContent, 'Starts in 8 s');
  assert.deepStrictEqual(last(env).upNext, { loadId: 'E2', inSec: 8, total: 8 });
  at(env, 2332);
  assert.strictEqual(env.els['upnext-count'].textContent, 'Starts in 4 s');
  assert.strictEqual(env.loads.length, 0);
  at(env, 2336);
  assert.strictEqual(env.loads.length, 1, 'the next episode, by the TV');
  const r = env.loads[0];
  assert.strictEqual(r.customData.nipa.loadId, 'E2');
  assert.strictEqual(r.customData.sender, 'nipa', 'the same handshake as the app\'s LOAD');
  assert(r.customData.features.nipaStatus);
  assert.strictEqual(r.currentTime, 30, 'from its own resume point');
  assert.strictEqual(r.media.contentUrl, 'http://p.example/series/u/secret/102.mkv');
  assert.strictEqual(r.media.metadata.seriesTitle, 'Show');
  assert.strictEqual(r.media.metadata.episode, 2);
  assert.strictEqual(r.media.metadata.images[0].url, 'http://img.example/2.jpg');
  await flush();
  assert.strictEqual(env.ev('session.loadId'), 'E2');
  assert.strictEqual(env.ev('session.queue.items.length'), 1, 'the rest of the queue came along');
  assert.strictEqual(last(env).loadId, 'E2');
  const qs = queueStates(env).at(-1);
  assert.strictEqual(qs.current, 'E2');
  assert.deepStrictEqual(qs.left, ['E3']);
  assert.deepStrictEqual(qs.history, [{ loadId: 'E1', pos: 2336, dur: 2400, finished: true }]);
  assert(!/secret|p\.example|img\.example|http/i.test(JSON.stringify(env.sent)), 'no URL leaves the TV');
});

test('queue: pausing freezes the count; seeking back out of the credits hides the card', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2)] });
  at(env, 2330);
  at(env, 2333);
  assert.strictEqual(env.els['upnext-count'].textContent, 'Starts in 5 s');
  env.clock.advance(60000);
  at(env, 2333);
  assert.strictEqual(env.loads.length, 0, 'paused: no time passes for the count');
  at(env, 1000);
  assert(env.els.upnext.classList.contains('hidden'));
  assert.strictEqual(last(env).upNext, undefined);
  at(env, 2330);
  assert.strictEqual(env.els['upnext-count'].textContent, 'Starts in 8 s', 'a fresh count');
});

test("queue: the series' learned scale moves the card later, and goes on with the queue", async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', creditsScale: 0.5, items: [ep(2), ep(3)] });
  at(env, 2363);
  assert(env.els.upnext.classList.contains('hidden'), 'half of 72 s: not before 36 s from the end');
  at(env, 2364);
  assert(!env.els.upnext.classList.contains('hidden'));
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', cmd: 'scale', creditsScale: 0.1 });
  assert.strictEqual(env.ev('session.queue.creditsScale'), 0.3, 'never under 30%');
  env.video.fire('ended');
  await flush();
  assert.strictEqual(env.ev('session.loadId'), 'E2');
  assert.strictEqual(env.ev('session.queue.creditsScale'), 0.3, 'carried to the next episode');
  env.video.duration = 600;        // 3% = 18 s → the 30 s minimum, × 0.3 = 9 → the 12 s floor
  at(env, 587);
  assert(env.els.upnext.classList.contains('hidden'));
  at(env, 588);
  assert(!env.els.upnext.classList.contains('hidden'));
});

test('queue: an episode that reaches its end goes on at once', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2)] });
  env.video.currentTime = 2400;
  env.video.fire('ended');
  assert.strictEqual(env.loads.length, 1);
  await flush();
  assert.strictEqual(env.ev('session.loadId'), 'E2');
  assert(!env.statuses().some((x) => x.loadId === 'E1' && x.state === 'ended'), 'not reported as the end of the cast');
});

test('queue: cancel from the app lets the episode end, and nothing follows', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2)] });
  at(env, 2330);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', cmd: 'cancel' });
  assert(env.els.upnext.classList.contains('hidden'));
  assert.strictEqual(last(env).queue.cancelled, true);
  at(env, 2399);
  env.video.fire('ended');
  assert.strictEqual(env.loads.length, 0);
  assert.strictEqual(last(env).state, 'ended');
});

test('queue: "next" from the app starts it now', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2)] });
  at(env, 600);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', cmd: 'next' });
  assert.strictEqual(env.loads.length, 1);
  await flush();
  assert.strictEqual(env.ev('session.loadId'), 'E2');
});

test("queue: one for another LOAD is ignored; the app's own new LOAD drops the queue", async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'OLD', items: [ep(2)] });
  assert.strictEqual(env.ev('session.queue'), null);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2)] });
  startEpisode(env, 'X9');
  assert.strictEqual(env.ev('session.queue'), null, 'a channel picked on the phone has no queue');
  env.video.fire('ended');
  assert.strictEqual(env.loads.length, 0);
});

test('queue: autoAdvance off: no card, the end is the end', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', autoAdvance: false, items: [ep(2)] });
  at(env, 2300);
  assert(env.els.upnext.classList.contains('hidden'));
  env.video.fire('ended');
  assert.strictEqual(env.loads.length, 0);
  assert.strictEqual(last(env).state, 'ended');
});

test('queue: CAF loading the episode without the interceptor is followed by hand', async () => {
  const env = setup();
  env.caf.routesOwnLoads = false;
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2), ep(3)] });
  env.video.fire('ended');
  await flush();
  assert.strictEqual(env.ev('session.loadId'), 'E2', 'its session, by hand');
  assert.strictEqual(env.video.src, 'http://p.example/series/u/secret/102.mkv', "CAF's file left in the element");
  assert.strictEqual(env.ev('session.queue.items.length'), 1);
  assert.strictEqual(queueStates(env).at(-1).current, 'E2');
});

test('queue: an app that comes back learns which episodes the TV played meanwhile', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2), ep(3)] });
  env.video.currentTime = 2400; env.video.fire('ended');
  await flush();
  env.video.duration = 2400; env.video.currentTime = 2400; env.video.fire('ended');
  await flush();
  assert.strictEqual(env.ev('session.loadId'), 'E3');
  env.fromApp({ type: 'hello', v: 1, app: 'nipa', locale: 'es-ES' }, 'app-2');
  const toApp = env.sent.filter((x) => x.to === 'app-2').map((x) => x.msg.type);
  assert.deepStrictEqual(toApp, ['hello', 'status', 'queue']);
  const qs = queueStates(env, 'app-2')[0];
  assert.strictEqual(qs.current, 'E3');
  assert.deepStrictEqual(qs.history.map((h) => h.loadId), ['E1', 'E2']);
  assert(qs.history.every((h) => h.finished));
});

test('queue: the next episode failing (e.g. HEVC) stops on its explanation, the queue kept for "next"', async () => {
  const env = setup();
  startEpisode(env);
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E1', items: [ep(2), ep(3)] });
  env.video.fire('ended');
  await flush();
  env.provider.answer = () => ({ status: 200, body: fixture('hevc10.mkv') });
  env.video.videoWidth = 0; env.video.webkitDecodedFrameCount = 0;
  env.video.fire('loadedmetadata');
  playFor(env, 1);
  env.clock.advance(3000); await flush();
  assert.strictEqual(last(env).loadId, 'E2');
  assert.strictEqual(last(env).state, 'failed');
  env.fromApp({ type: 'queue', v: 1, forLoadId: 'E2', cmd: 'next' });
  await flush();
  assert.strictEqual(env.ev('session.loadId'), 'E3');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      allInstances.length = 0;
      readsWhileBusy.n = 0;
      await fn();
      assert.strictEqual(readsWhileBusy.n, 0, `${readsWhileBusy.n} read(s) of the file while the element held it`);
      const bad = allInstances.filter((h) => h.destroyedDuringEmit).length;
      assert.strictEqual(bad, 0, `${bad} hls instance(s) destroyed inside their own event callback`);
      console.log('ok  ', name);
    }
    catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
  }
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
