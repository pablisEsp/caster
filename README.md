# IPTV Cast Receiver

Custom Google Cast receiver that uses [hls.js](https://github.com/video-dev/hls.js/) for HLS stream playback, bypassing the default Chromecast receiver's codec limitations.

## Why?

The default Chromecast receiver can't play many IPTV streams (HEVC, non-standard HLS, etc.). This custom receiver uses hls.js which handles virtually any HLS stream format.

## Setup

### 1. Deploy to GitHub Pages

1. Push this repo to GitHub (public)
2. Go to **Settings → Pages**
3. Source: **Deploy from a branch**
4. Branch: `main`, folder: `/ (root)`
5. Save — your receiver will be at: `https://<username>.github.io/caster/`

### 2. Register on Google Cast Developer Console

1. Go to [cast.google.com/publish](https://cast.google.com/publish)
2. Pay the one-time $5 registration fee
3. Click **Add New Application** → **Custom Receiver**
4. **Name**: `IPTV Receiver` (or whatever you want)
5. **Receiver Application URL**: `https://<username>.github.io/caster/`
6. Save — you'll get an **App ID** (e.g., `A1B2C3D4`)

### 3. Register your Chromecast as a test device

While the App ID propagates (can take hours), register your Chromecast for immediate testing:

1. In the Cast Developer Console, go to **Devices**  
2. Click **Add New Device**
3. Enter your Chromecast's **serial number** (find it in Google Home app → device settings)
4. Wait ~15 minutes for it to register

### 4. Update the Flutter app

In `main.dart` (before `CastService.instance.init()`):

```dart
CastService.customAppId = 'YOUR_APP_ID_HERE';
```

## How it works

```
Flutter App  →  Chromecast loads this HTML  →  hls.js plays the stream
    │                    │
    └─ sends URL ───────→└─ hls.js downloads .m3u8 + .ts segments
                              and decodes them via MediaSource Extensions
```

The receiver intercepts Cast LOAD messages and uses hls.js instead of the default player. It also handles PAUSE, PLAY, SEEK, STOP, and VOLUME commands from the sender app.
