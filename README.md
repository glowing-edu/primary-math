# 幼兒數學大冒險 · Primary Math Adventure

A Cantonese math-learning game for 5-year-olds (10-frame number bonds, 湊十法,
破十法, 平十法, 借十法), with per-child profiles and optional Puter cloud sync.
Built as a static site with Vite and deployed to GitHub Pages.

## Features

- 🎮 **Five stages** — 10的組成、合十法、破十法、平十法、借十法
- 🗣️ **Cantonese speech** — hints and explanations via the browser Web Speech API
- 👧🧒 **Multi-profile** — one profile per child, each with their own stars,
  stage progress and answer history
- ☁️ **Puter cloud sync** — sign in with a Puter account to store every profile's
  progress in your own Puter space and continue on another device
- 💾 **Offline-first** — everything is saved to `localStorage`; Puter is optional
  and only adds cross-device sync
- 🚀 **GitHub Pages** — every push to `main` builds and deploys automatically

## How progress is stored

Each answer is saved immediately under the active profile:

```
primary-math-profiles-v1          # profile list
primary-math-current-profile-v1   # active profile id
primary-math-progress-v1-<id>     # one entry per child
```

Progress shape:

```js
{
  score: 10,        // stars shown in the game (10 per correct answer)
  correct: 1,
  attempts: 1,
  stages: { "1": { correct: 1, attempts: 1 } },
  lastStage: 1,
  updatedAt: 1790000000000
}
```

Profiles are soft-deleted and can be restored for **30 days**. Deleting a
profile never deletes another child's progress.

## Puter sync

1. Click **☁️ 登入同步** in the header and sign in with Puter.
2. Choose a profile and keep playing — progress auto-uploads a couple of
   seconds after each answer.
3. On another device, sign in with the same Puter account: the app pulls the
   cloud data on load.
4. **上載本機進度** / **下載雲端進度** force a manual merge in either direction.

Sync is merge-only: a cloud profile is never removed by an upload, and local
progress is never overwritten by an older cloud copy. Cloud data lives in the
Puter key-value store under `primary-math-profiles-backup-v1`.

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # production build into dist/
npm run preview  # preview the production build
```

## Deploy to GitHub Pages

1. Push this repo to GitHub (default branch `main`).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` runs `.github/workflows/deploy.yml`, which builds and
   publishes `dist/` automatically.

`vite.config.js` uses `base: './'`, so the build works on a project Pages site
(`https://<user>.github.io/primary-math/`) as well as locally.

## Project structure

```
index.html                 # game markup + game engine (Cantonese speech, stages)
src/main.js                # profile switcher UI + Puter sync panel + boot
src/lib/profiles.js        # localStorage multi-profile progress store
src/lib/puterSync.js       # Puter KV snapshots, merge and sync logic
public/favicon.svg
.github/workflows/deploy.yml
```
