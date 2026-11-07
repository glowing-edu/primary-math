// App shell for Primary Math: multi-profile progress + optional Puter sync.
// The game itself stays in index.html; this module wires persistence into it.

import {
  AVATARS,
  DELETED_RETENTION_DAYS,
  createProfile,
  deleteProfile,
  initProfiles,
  markStage,
  recordAnswer,
  restoreProfile,
  saveProgress,
  switchProfile,
  updateProfile,
} from './lib/profiles.js'
import {
  getCloudSummary,
  getUser,
  isPuterAvailable,
  isSignedIn,
  signIn,
  signOut,
  smartSync,
} from './lib/puterSync.js'

const AUTO_SYNC_DELAY_MS = 2500
const AUTO_SYNC_DAY_KEY = 'primary-math-auto-sync-day'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const $ = (id) => document.getElementById(id)

let state = null
let profileMenuOpen = false
let profileMode = 'list' // list | add | rename | restore
let editingId = null
let editName = ''
let editAvatar = AVATARS[0]

let cloudOpen = false
let cloud = null
let cloudLoading = false
let syncing = false
let autoSyncing = false
let autoSyncDayCache = null
let note = null
let lastSync = null
let auth = isPuterAvailable() ? 'checking' : 'unavailable'
let user = null
let syncTimer = null

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function currentProfile() {
  if (!state) return null
  return state.profiles.find((p) => p.id === state.currentId) || state.profiles[0] || null
}

function formatTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-HK', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Automatic syncing is limited to one successful run per calendar day.
// Manual sync buttons bypass this entirely.
function todayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function autoSyncedToday() {
  if (autoSyncDayCache === todayKey()) return true
  try {
    return localStorage.getItem(AUTO_SYNC_DAY_KEY) === todayKey()
  } catch {
    return false
  }
}

function markAutoSyncedToday() {
  autoSyncDayCache = todayKey()
  try {
    localStorage.setItem(AUTO_SYNC_DAY_KEY, autoSyncDayCache)
  } catch {
    // ignore
  }
}

function applyGameProgress() {
  if (state && typeof window.applySavedProgress === 'function') {
    window.applySavedProgress(state.progress)
  }
}

// ---------------------------------------------------------------- profiles UI

function renderProfileUI() {
  const root = $('profile-root')
  if (!root || !state) return
  const current = currentProfile()
  const name = escapeHtml(current?.name || '小朋友')
  const avatar = escapeHtml(current?.avatar || AVATARS[0])

  root.innerHTML = `
    <div class="relative">
      <button id="profile-btn" type="button"
        class="bounce-btn flex items-center gap-2 bg-white/90 hover:bg-white border-2 border-sky-200 rounded-2xl px-3 py-2 shadow-sm transition"
        aria-label="切換小朋友 Switch profile">
        <span class="text-xl leading-none">${avatar}</span>
        <span class="font-bold text-sm text-slate-700 max-w-[7rem] truncate">${name}</span>
        <span class="text-slate-400 text-xs" aria-hidden="true">▾</span>
      </button>
      <div id="profile-menu" class="${profileMenuOpen ? '' : 'hidden'} absolute right-0 top-full mt-2 w-72 bg-white rounded-2xl border-2 border-sky-100 shadow-2xl z-50 overflow-hidden"></div>
    </div>
  `

  $('profile-btn').onclick = () => {
    profileMenuOpen = !profileMenuOpen
    if (profileMenuOpen) {
      profileMode = 'list'
      cloudOpen = false
      renderCloudUI()
    }
    renderProfileUI()
  }

  renderProfileMenu()
}

function menuButton(action, id, label, extraClass = '') {
  return `<button type="button" data-action="${action}"${id ? ` data-id="${id}"` : ''}
    class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left text-sm font-bold hover:bg-sky-50 text-slate-700 transition ${extraClass}">
    ${label}
  </button>`
}

function renderProfileMenu() {
  const menu = $('profile-menu')
  if (!menu || !state) return

  if (profileMode === 'restore') {
    menu.innerHTML = `
      <div class="p-3 border-b border-slate-100">
        <h3 class="font-black text-slate-700">♻️ 還原小朋友</h3>
        <p class="text-[11px] text-slate-500 mt-1 leading-relaxed">
          刪除咗嘅小朋友會保留 ${DELETED_RETENTION_DAYS} 日，可以還原。<br />
          Deleted profiles are kept for ${DELETED_RETENTION_DAYS} days.
        </p>
      </div>
      <div class="p-2 space-y-1 max-h-64 overflow-y-auto">
        ${
          state.deletedProfiles.length === 0
            ? '<p class="px-3 py-4 text-xs text-slate-500 text-center">冇可以還原嘅小朋友。<br />Nothing to restore.</p>'
            : state.deletedProfiles
                .map(
                  (p) => `
              <button type="button" data-action="restore" data-id="${p.id}"
                class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left hover:bg-emerald-50 transition">
                <span class="text-xl">${escapeHtml(p.avatar)}</span>
                <span class="flex-1 min-w-0">
                  <span class="block text-sm font-bold text-slate-700 truncate">${escapeHtml(p.name)}</span>
                  <span class="block text-[10px] text-slate-400">${daysLeft(p.deletedAt)} 日後清除</span>
                </span>
                <span aria-hidden="true">♻️</span>
              </button>`,
                )
                .join('')
        }
      </div>
      <div class="p-2 border-t border-slate-100">
        ${menuButton('back', null, '← 返回 Back')}
      </div>
    `
  } else if (profileMode === 'add' || profileMode === 'rename') {
    const isAdd = profileMode === 'add'
    menu.innerHTML = `
      <form id="profile-form" class="p-3">
        <h3 class="font-black text-slate-700">${isAdd ? '➕ 新增小朋友' : '✏️ 改名'}</h3>
        <input id="profile-name-input" type="text" maxlength="12" value="${escapeHtml(editName)}"
          placeholder="小朋友名稱 Name"
          class="mt-3 w-full border-2 border-slate-200 focus:border-sky-400 rounded-xl px-3 py-2 text-sm font-bold outline-none" />
        <div class="mt-3 grid grid-cols-4 gap-2">
          ${AVATARS.map(
            (a) => `
            <button type="button" data-action="avatar" data-avatar="${a}" aria-label="${a}"
              class="profile-avatar-btn text-2xl h-11 rounded-xl border-2 transition ${a === editAvatar ? 'border-sky-400 bg-sky-50' : 'border-transparent hover:bg-slate-50'}">${a}</button>`,
          ).join('')}
        </div>
        <div class="mt-4 flex justify-end gap-2">
          ${menuButton('cancel', null, '取消 Cancel', '!w-auto !px-4 bg-slate-100')}
          ${menuButton('save', null, '儲存 Save', '!w-auto !px-4 !bg-sky-500 !text-white hover:!bg-sky-600')}
        </div>
      </form>
    `
    const input = $('profile-name-input')
    input.value = editName
    input.oninput = (e) => {
      editName = e.target.value
    }
    input.focus()
    input.select()
  } else {
    const current = currentProfile()
    menu.innerHTML = `
      <div class="p-2 space-y-1 max-h-64 overflow-y-auto">
        ${state.profiles
          .map(
            (p) => `
          <button type="button" data-action="switch" data-id="${p.id}"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition ${
              p.id === current?.id ? 'bg-sky-50 text-sky-700' : 'hover:bg-slate-50 text-slate-700'
            }">
            <span class="text-xl">${escapeHtml(p.avatar)}</span>
            <span class="flex-1 text-sm font-bold truncate">${escapeHtml(p.name)}</span>
            ${p.id === current?.id ? '<span class="text-sky-500" aria-hidden="true">✓</span>' : ''}
          </button>`,
          )
          .join('')}
      </div>
      <div class="p-2 border-t border-slate-100 space-y-1">
        ${menuButton('add', null, '➕ 新增小朋友 Add')}
        ${current ? menuButton('rename', current.id, '✏️ 改名 Rename') : ''}
        ${
          state.profiles.length > 1 && current
            ? menuButton('delete', current.id, '🗑️ 刪除 Delete', 'text-rose-600 hover:!bg-rose-50')
            : ''
        }
        ${
          state.deletedProfiles.length > 0
            ? menuButton('restore-list', null, `♻️ 還原小朋友 Restore (${state.deletedProfiles.length})`)
            : ''
        }
      </div>
    `
  }

  menu.onclick = handleProfileMenuClick
}

function daysLeft(deletedAt) {
  if (!deletedAt) return DELETED_RETENTION_DAYS
  const elapsed = Math.floor((Date.now() - deletedAt) / (24 * 60 * 60 * 1000))
  return Math.max(1, DELETED_RETENTION_DAYS - elapsed)
}

async function handleProfileMenuClick(event) {
  const btn = event.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const id = btn.dataset.id

  if (action === 'switch') {
    const next = switchProfile(id)
    if (!next) return
    state = next
    profileMenuOpen = false
    renderProfileUI()
    applyGameProgress()
  } else if (action === 'add') {
    profileMode = 'add'
    editingId = null
    editName = `小朋友 ${state.profiles.length + 1}`
    editAvatar = AVATARS[state.profiles.length % AVATARS.length]
    renderProfileMenu()
  } else if (action === 'rename') {
    const profile = state.profiles.find((p) => p.id === id)
    if (!profile) return
    profileMode = 'rename'
    editingId = id
    editName = profile.name
    editAvatar = profile.avatar || AVATARS[0]
    renderProfileMenu()
  } else if (action === 'avatar') {
    editAvatar = btn.dataset.avatar
    const menu = $('profile-menu')
    menu.querySelectorAll('[data-action="avatar"]').forEach((el) => {
      const selected = el.dataset.avatar === editAvatar
      el.classList.toggle('border-sky-400', selected)
      el.classList.toggle('bg-sky-50', selected)
      el.classList.toggle('border-transparent', !selected)
    })
    const input = $('profile-name-input')
    if (input) input.focus()
  } else if (action === 'save') {
    saveProfileForm()
  } else if (action === 'cancel') {
    profileMode = 'list'
    renderProfileMenu()
  } else if (action === 'back') {
    profileMode = 'list'
    renderProfileMenu()
  } else if (action === 'restore-list') {
    profileMode = 'restore'
    renderProfileMenu()
  } else if (action === 'delete') {
    const profile = state.profiles.find((p) => p.id === id)
    if (!profile) return
    const ok = window.confirm(
      `刪除「${profile.name}」？進度會保留 ${DELETED_RETENTION_DAYS} 日，可以還原。\nDelete ${profile.name}? Progress is kept for ${DELETED_RETENTION_DAYS} days.`,
    )
    if (!ok) return
    const next = deleteProfile(id)
    if (!next) {
      window.alert('至少要保留一個小朋友。\nAt least one profile must remain.')
      return
    }
    state = next
    profileMenuOpen = false
    renderProfileUI()
    applyGameProgress()
    scheduleAutoSync()
  } else if (action === 'restore') {
    const profile = state.deletedProfiles.find((p) => p.id === id)
    if (!profile) return
    const ok = window.confirm(
      `還原「${profile.name}」同佢嘅進度？\nRestore ${profile.name} and their progress?`,
    )
    if (!ok) return
    const next = restoreProfile(id)
    if (!next) return
    state = next
    profileMenuOpen = false
    renderProfileUI()
    applyGameProgress()
    scheduleAutoSync()
  }
}

function saveProfileForm() {
  const input = $('profile-name-input')
  const name = (input?.value || editName || '').trim()
  if (!name) {
    input?.focus()
    return
  }

  if (profileMode === 'add') {
    state = createProfile(name, editAvatar)
    profileMode = 'list'
    profileMenuOpen = false
    renderProfileUI()
    applyGameProgress()
    scheduleAutoSync()
  } else if (profileMode === 'rename' && editingId) {
    const result = updateProfile(editingId, { name, avatar: editAvatar })
    state = { ...state, profiles: result.profiles, deletedProfiles: result.deletedProfiles }
    profileMode = 'list'
    renderProfileUI()
    scheduleAutoSync()
  }
}

// ------------------------------------------------------------------- cloud UI

function cloudLabel() {
  if (auth === 'checking') return '☁️ 檢查中…'
  if (auth === 'signedIn') {
    const who = user?.username || user?.email
    return `☁️ ${who || '已登入'}`
  }
  return '☁️ 登入同步'
}

function renderCloudUI() {
  const root = $('cloud-sync-root')
  if (!root) return
  if (!isPuterAvailable()) {
    root.innerHTML = ''
    return
  }

  const active = auth === 'signedIn'
  root.innerHTML = `
    <div class="relative">
      <button id="cloud-btn" type="button"
        class="bounce-btn flex items-center gap-2 border-2 rounded-2xl px-3 py-2 shadow-sm transition text-sm font-bold ${
          active
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
            : 'bg-white/90 border-sky-200 text-slate-700 hover:bg-white'
        }">
        <span>${cloudLabel()}</span>
        ${syncing ? '<span class="animate-spin inline-block" aria-hidden="true">◌</span>' : ''}
      </button>
      <div id="cloud-panel" class="${cloudOpen ? '' : 'hidden'} absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-2xl border-2 border-sky-100 shadow-2xl z-50 p-4"></div>
    </div>
  `

  $('cloud-btn').onclick = () => {
    cloudOpen = !cloudOpen
    if (cloudOpen) {
      profileMenuOpen = false
      renderProfileUI()
    }
    renderCloudUI()
    if (cloudOpen) refreshCloudSummary()
  }

  const panel = $('cloud-panel')
  if (!panel) return
  panel.onclick = handleCloudPanelClick
  renderCloudPanel(panel)
}

function renderCloudPanel(panel) {
  if (auth === 'checking') {
    panel.innerHTML = `<p class="text-sm text-slate-500 py-2 text-center">檢查登入狀態…<br />Checking sign-in…</p>`
    return
  }

  if (auth !== 'signedIn') {
    panel.innerHTML = `
      <p class="text-sm font-bold text-slate-700">用 Puter 帳戶同步進度</p>
      <p class="text-[11px] text-slate-500 mt-1 leading-relaxed">登入後，每位小朋友嘅進度會儲存喺你嘅 Puter 雲端空間，換裝置都搵得返。<br />Sign in to save every child's progress to your Puter account.</p>
      <button type="button" data-cloud-action="signin" class="mt-3 w-full bg-emerald-500 hover:bg-emerald-600 text-white font-black rounded-xl py-2.5 transition">登入 Sign In</button>
      ${note ? `<p class="mt-3 text-xs text-rose-600">${escapeHtml(note)}</p>` : ''}
    `
    return
  }

  const cloudProfiles = cloud?.profiles || []
  panel.innerHTML = `
    <p class="text-xs text-slate-500 truncate">${escapeHtml(user?.username || user?.email || '')}</p>

    <div class="mt-3 bg-slate-50 border border-slate-200 rounded-xl p-2.5">
      <div class="flex items-center justify-between">
        <strong class="text-xs text-slate-700">雲端資料 Cloud</strong>
        <button type="button" data-cloud-action="refresh" class="text-[11px] text-sky-600 font-bold" ${cloudLoading ? 'disabled' : ''}>
          ${cloudLoading ? '讀取中…' : '↻ 重新整理'}
        </button>
      </div>
      ${
        cloud
          ? `<p class="text-[11px] text-slate-500 mt-1">更新 ${formatTime(cloud.updatedAt)}</p>
             <p class="text-[11px] text-slate-700 mt-0.5">${cloudProfiles.length} 個小朋友${
               cloudProfiles.length
                 ? ` · ${escapeHtml(cloudProfiles.map((p) => `${p.avatar || ''}${p.name}`).join('、'))}`
                 : ''
             }</p>
             ${cloud.deletedCount > 0 ? `<p class="text-[10px] text-slate-400 mt-0.5">另有 ${cloud.deletedCount} 個已刪除（保留中）</p>` : ''}`
          : `<p class="text-[11px] text-amber-700 mt-1">${cloudLoading ? '讀取中…' : '雲端未有資料 No cloud data'}</p>`
      }
    </div>

    ${lastSync ? `<p class="text-[11px] text-slate-500 mt-2">上次同步 ${formatTime(lastSync)}</p>` : ''}
    ${autoSyncedToday() ? '<p class="text-[11px] text-emerald-600 mt-1">今日已自動同步 Auto-synced today</p>' : ''}
    ${note ? `<p class="text-[11px] mt-1 ${note === '已是最新狀態 Up to date' ? 'text-emerald-600' : 'text-rose-600'}">${escapeHtml(note)}</p>` : ''}

    <button type="button" data-cloud-action="upload" ${syncing ? 'disabled' : ''}
      class="mt-3 w-full rounded-xl py-2.5 font-black text-white transition ${syncing ? 'bg-slate-300 cursor-not-allowed' : 'bg-sky-500 hover:bg-sky-600'}">
      ${syncing ? '同步中…' : '上載本機進度 Upload'}
    </button>
    <button type="button" data-cloud-action="download" ${syncing ? 'disabled' : ''}
      class="mt-2 w-full rounded-xl py-2.5 font-black text-white transition ${syncing ? 'bg-slate-300 cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600'}">
      ${syncing ? '同步中…' : '下載雲端進度 Download'}
    </button>
    <button type="button" data-cloud-action="signout" ${syncing ? 'disabled' : ''}
      class="mt-2 w-full rounded-xl py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm transition">
      登出 Sign Out
    </button>
    <p class="mt-3 text-[10px] text-slate-400 leading-relaxed">
      上載只會合併，唔會刪除雲端嘅小朋友。進度每日自動同步一次，亦可隨時手動同步。<br />
      Uploads only merge; no cloud profile is ever removed automatically. Progress syncs automatically once a day; manual sync is always available.
    </p>
  `
}

async function handleCloudPanelClick(event) {
  const btn = event.target.closest('[data-cloud-action]')
  if (!btn) return
  const action = btn.dataset.cloudAction
  if (action === 'signin') await handleSignIn()
  else if (action === 'signout') await handleSignOut()
  else if (action === 'upload') await runSync({ push: true, silent: false, force: true })
  else if (action === 'download') await runSync({ push: false, silent: false, force: true })
  else if (action === 'refresh') await refreshCloudSummary()
}

async function checkAuth({ retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (await isSignedIn()) {
        auth = 'signedIn'
        user = await getUser()
        return true
      }
    } catch (err) {
      console.error(err)
    }
    if (attempt < retries) await sleep(600)
  }
  auth = 'signedOut'
  user = null
  return false
}

async function refreshCloudSummary() {
  if (auth !== 'signedIn' || cloudLoading) return
  cloudLoading = true
  renderCloudUI()
  try {
    cloud = await getCloudSummary()
  } catch (err) {
    note = err.message
  } finally {
    cloudLoading = false
    renderCloudUI()
  }
}

async function handleSignIn() {
  try {
    note = null
    await signIn()
    const ok = await checkAuth({ retries: 2 })
    if (ok) {
      cloudOpen = true
      await runSync({ push: true, silent: false, force: true })
    } else {
      renderCloudUI()
    }
  } catch (err) {
    note = err.message
    renderCloudUI()
  }
}

async function handleSignOut() {
  try {
    await signOut()
  } catch {
    // ignore
  }
  auth = 'signedOut'
  user = null
  cloud = null
  lastSync = null
  note = null
  renderCloudUI()
}

// Run a sync. `applyChanges` controls whether the game is reloaded with the
// merged progress (manual/boot sync) or left alone mid-question (auto sync).
async function runSync({ push = true, silent = false, force = true, applyChanges = !silent } = {}) {
  if (!isPuterAvailable() || auth !== 'signedIn') return null
  if (syncing) return null

  syncing = true
  if (!silent) note = null
  renderCloudUI()

  try {
    const result = await smartSync({ push, force })
    lastSync = Date.now()

    if (result.changed) {
      state = initProfiles()
      renderProfileUI()
      if (applyChanges) applyGameProgress()
    }

    if (!silent) {
      note = result.action === 'none' ? '已是最新狀態 Up to date' : '同步完成 Synced'
    }

    try {
      cloud = await getCloudSummary()
    } catch {
      // keep the previous summary
    }
    return result
  } catch (err) {
    if (silent) console.error('Auto sync failed:', err)
    else note = err.message
    return null
  } finally {
    syncing = false
    renderCloudUI()
  }
}

// Automatic sync runs at most once per calendar day. Successful manual syncs
// do not consume the daily slot, so progress can still be uploaded later.
async function runAutoSync({ applyChanges = false } = {}) {
  if (!isPuterAvailable() || auth !== 'signedIn') return null
  if (autoSyncing || autoSyncedToday()) return null

  autoSyncing = true
  try {
    const result = await runSync({ push: true, silent: true, force: false, applyChanges })
    if (result) markAutoSyncedToday()
    return result
  } finally {
    autoSyncing = false
  }
}

function scheduleAutoSync() {
  if (!isPuterAvailable() || auth !== 'signedIn') return
  if (autoSyncedToday()) return

  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    runAutoSync({ applyChanges: false })
  }, AUTO_SYNC_DELAY_MS)
}

// ---------------------------------------------------------------------- boot

async function boot() {
  state = initProfiles()
  renderProfileUI()
  renderCloudUI()
  applyGameProgress()

  if (!isPuterAvailable()) return
  const signed = await checkAuth()
  renderCloudUI()
  if (signed) {
    await runAutoSync({ applyChanges: true })
  }
}

// Bridge used by the game engine in index.html.
window.GameProgress = {
  record(stage, correct) {
    if (!state) return
    const score = typeof window.getGameScore === 'function' ? window.getGameScore() : state.progress.score
    const next = recordAnswer(state.progress, stage, correct, score)
    state = { ...state, progress: next }
    saveProgress(state.currentId, next)
    scheduleAutoSync()
  },
  setStage(stage) {
    if (!state) return
    const next = markStage(state.progress, stage)
    state = { ...state, progress: next }
    saveProgress(state.currentId, next)
    scheduleAutoSync()
  },
}

window.PrimaryMathApp = { boot }

// True when the click started inside `id`. We must use the dispatch-time
// composedPath: the toggle handlers re-render these roots, which detaches the
// clicked button before the event bubbles here, so `target.closest()` would
// wrongly report an outside click and immediately close the dropdown.
function clickStartedIn(event, id) {
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath()
    if (path.length > 0) {
      return path.some((node) => node instanceof Element && node.id === id)
    }
  }
  const target = event.target
  return target instanceof Element && !!target.closest(`#${id}`)
}

// Close open dropdowns when tapping/clicking elsewhere on the page.
document.addEventListener('click', (event) => {
  if (profileMenuOpen && !clickStartedIn(event, 'profile-root')) {
    profileMenuOpen = false
    renderProfileUI()
  }
  if (cloudOpen && !clickStartedIn(event, 'cloud-sync-root')) {
    cloudOpen = false
    renderCloudUI()
  }
})
