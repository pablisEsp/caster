// Runs the receiver's main inline script in a vm with fakes for the DOM,
// CAF and hls.js, plus a manual clock, and checks the playback-session logic.
'use strict';
const fs = require('fs');
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
    playCalls: 0,
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() {}, removeAttribute(a) { if (a === 'src') this.src = ''; },
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
      getPlayerManager: () => ({ setMessageInterceptor: (t, fn) => { interceptors[t] = fn; }, broadcastStatus() {} }),
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
      Command: { ALL_BASIC_MEDIA: 1 },
    },
  } };

  const ctx = {
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
  return { ctx, ev, clock, video, els, instances, interceptors, Hls, sent, statuses, fromApp, device, startOptions: () => startOptions };
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

test('the ready words: never in the wrong language first; the next launch starts in the app\'s', async () => {
  const STR = (lang) => setup().ev('STRINGS')[lang];
  const words = (env) => env.els['ready-text'].classList.contains('pending') ? null : env.els['ready-title'].textContent;
  // First launch on this TV (an English one): nothing kept, the words wait.
  const kept = {};
  const first = setup({ storage: kept, lang: 'en-GB' });
  assert.strictEqual(words(first), null, 'hidden until the app says');
  first.clock.advance(1000);
  first.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'ios', locale: 'es-ES' });
  assert.strictEqual(words(first), STR('es').readyTitle, 'straight in Spanish');
  assert.strictEqual(kept['nipa.lang'], 'es');
  // Next launch: Spanish from the first frame.
  const next = setup({ storage: kept, lang: 'en-GB' });
  assert.strictEqual(words(next), STR('es').readyTitle);
  assert.strictEqual(next.ctx.document.documentElement.lang, 'es');
  // Another phone in German: the words fade out, swap, and come back.
  next.fromApp({ type: 'hello', v: 1, app: 'nipa', version: '1.5.1', platform: 'android', locale: 'de-DE' });
  assert.strictEqual(words(next), null, 'fading out');
  next.clock.advance(500);
  assert.strictEqual(next.els['ready-title'].textContent, STR('es').readyTitle, 'not swapped before the fade ends');
  next.els['ready-text'].fire('transitionend');
  assert.strictEqual(words(next), STR('de').readyTitle);
  assert.strictEqual(kept['nipa.lang'], 'de');
  // An app that never says (an old version): the device's language, after a moment.
  const silent = setup({ storage: {}, lang: 'fr-FR' });
  silent.clock.advance(2400);
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

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      allInstances.length = 0;
      await fn();
      const bad = allInstances.filter((h) => h.destroyedDuringEmit).length;
      assert.strictEqual(bad, 0, `${bad} hls instance(s) destroyed inside their own event callback`);
      console.log('ok  ', name);
    }
    catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
  }
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
