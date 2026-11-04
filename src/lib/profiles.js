// Multi-profile progress system for Primary Math.
// Every profile keeps its own progress under a profile-scoped localStorage key,
// so switching children never mixes up their stars or stage progress.

const PROFILES_KEY = 'primary-math-profiles-v1'
const CURRENT_KEY = 'primary-math-current-profile-v1'
const PROGRESS_PREFIX = 'primary-math-progress-v1-'

// Deleted profiles stay recoverable for this many days.
export const DELETED_RETENTION_DAYS = 30
const DELETED_RETENTION_MS = DELETED_RETENTION_DAYS * 24 * 60 * 60 * 1000

export const STAGE_COUNT = 5

export const DEFAULT_PROGRESS = {
  score: 0, // stars shown in the game (10 per correct answer)
  correct: 0, // total correct answers
  attempts: 0, // total answers
  stages: {}, // { [stageId]: { correct, attempts } }
  lastStage: 1,
  updatedAt: 0,
}

export const AVATARS = ['🐻', '🐰', '🐱', '🐶', '🐼', '🦊', '🐸', '🦄']

let idCounter = 0

function generateId() {
  idCounter += 1
  return `p_${Date.now()}_${idCounter}_${Math.random().toString(36).slice(2, 9)}`
}

// Fresh, independent copy of the default progress object.
export function freshProgress() {
  return {
    ...DEFAULT_PROGRESS,
    stages: {},
  }
}

export function normalizeProgress(saved) {
  if (!saved || typeof saved !== 'object') return freshProgress()
  const stages = {}
  if (saved.stages && typeof saved.stages === 'object') {
    for (const [id, stats] of Object.entries(saved.stages)) {
      if (!stats || typeof stats !== 'object') continue
      stages[id] = {
        correct: Math.max(0, Number(stats.correct) || 0),
        attempts: Math.max(0, Number(stats.attempts) || 0),
      }
    }
  }
  return {
    score: Math.max(0, Number(saved.score) || 0),
    correct: Math.max(0, Number(saved.correct) || 0),
    attempts: Math.max(0, Number(saved.attempts) || 0),
    stages,
    lastStage: Math.min(STAGE_COUNT, Math.max(1, Number(saved.lastStage) || 1)),
    updatedAt: Number(saved.updatedAt) || 0,
  }
}

// Record one answer for a stage and return a new progress object.
export function recordAnswer(progress, stage, correct, score) {
  const base = normalizeProgress(progress)
  const stageId = String(stage)
  const stageStats = base.stages[stageId] || { correct: 0, attempts: 0 }
  const stages = {
    ...base.stages,
    [stageId]: {
      correct: stageStats.correct + (correct ? 1 : 0),
      attempts: stageStats.attempts + 1,
    },
  }
  return {
    ...base,
    score: Math.max(base.score, Math.max(0, Number(score) || 0)),
    correct: base.correct + (correct ? 1 : 0),
    attempts: base.attempts + 1,
    stages,
    lastStage: Math.min(STAGE_COUNT, Math.max(1, Number(stage) || 1)),
    updatedAt: Date.now(),
  }
}

export function markStage(progress, stage) {
  const base = normalizeProgress(progress)
  return {
    ...base,
    lastStage: Math.min(STAGE_COUNT, Math.max(1, Number(stage) || 1)),
    updatedAt: Date.now(),
  }
}

export function stageStats(progress, stage) {
  const normalized = normalizeProgress(progress)
  return normalized.stages[String(stage)] || { correct: 0, attempts: 0 }
}

function isDeleted(profile) {
  return Boolean(profile?.deletedAt)
}

// Timestamp of the last change to a profile record. Used when merging so a
// delete/restore/rename is not undone by an older copy from another device.
export function profileTimestamp(profile) {
  if (!profile) return 0
  return profile.updatedAt || profile.deletedAt || profile.createdAt || 0
}

function activeOf(profiles) {
  return profiles.filter((p) => !isDeleted(p))
}

function deletedOf(profiles) {
  return profiles.filter((p) => isDeleted(p))
}

function loadProfiles() {
  try {
    const raw = window.localStorage.getItem(PROFILES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return purgeExpiredProfiles(parsed)
  } catch {
    return []
  }
}

function saveProfiles(profiles) {
  try {
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
  } catch {
    // ignore (private mode / quota)
  }
}

// Drop profiles that were deleted more than DELETED_RETENTION_DAYS ago.
function purgeExpiredProfiles(profiles) {
  const now = Date.now()
  let changed = false
  const kept = []
  for (const p of profiles) {
    if (isDeleted(p) && now - p.deletedAt > DELETED_RETENTION_MS) {
      changed = true
      try {
        window.localStorage.removeItem(PROGRESS_PREFIX + p.id)
      } catch {
        // ignore
      }
    } else {
      kept.push(p)
    }
  }
  if (changed) saveProfiles(kept)
  return kept
}

function getCurrentId() {
  try {
    return window.localStorage.getItem(CURRENT_KEY)
  } catch {
    return null
  }
}

function setCurrentId(id) {
  try {
    window.localStorage.setItem(CURRENT_KEY, id)
  } catch {
    // ignore
  }
}

export function loadProgress(id) {
  try {
    const raw = window.localStorage.getItem(PROGRESS_PREFIX + id)
    if (!raw) return freshProgress()
    return normalizeProgress(JSON.parse(raw))
  } catch {
    return freshProgress()
  }
}

export function saveProgress(id, progress) {
  try {
    window.localStorage.setItem(PROGRESS_PREFIX + id, JSON.stringify(normalizeProgress(progress)))
  } catch {
    // ignore
  }
}

function makeProfile(name, avatar, index) {
  const now = Date.now()
  return {
    id: generateId(),
    name: (name || '').trim() || `小朋友 ${index + 1}`,
    avatar: avatar || AVATARS[index % AVATARS.length],
    createdAt: now,
    updatedAt: now,
  }
}

function stateFromProfiles(all) {
  const profiles = activeOf(all)
  const deletedProfiles = deletedOf(all)
  let currentId = getCurrentId()
  if (!currentId || !profiles.find((p) => p.id === currentId)) {
    currentId = profiles[0]?.id ?? null
    if (currentId) setCurrentId(currentId)
  }
  return {
    profiles,
    deletedProfiles,
    currentId,
    progress: currentId ? loadProgress(currentId) : freshProgress(),
  }
}

export function initProfiles() {
  let all = loadProfiles()

  // First run: create a default child profile.
  if (activeOf(all).length === 0) {
    const profile = makeProfile('小朋友 1', AVATARS[0], 0)
    all = [...all, profile]
    saveProfiles(all)
    setCurrentId(profile.id)
    const progress = freshProgress()
    saveProgress(profile.id, progress)
    return { profiles: activeOf(all), deletedProfiles: deletedOf(all), currentId: profile.id, progress }
  }

  return stateFromProfiles(all)
}

export function createProfile(name, avatar) {
  const all = loadProfiles()
  const active = activeOf(all)
  const profile = makeProfile(name, avatar, active.length)
  const next = [...all, profile]
  saveProfiles(next)
  const progress = freshProgress()
  saveProgress(profile.id, progress)
  setCurrentId(profile.id)
  return {
    profiles: activeOf(next),
    deletedProfiles: deletedOf(next),
    currentId: profile.id,
    progress,
  }
}

export function switchProfile(id) {
  const all = loadProfiles()
  const active = activeOf(all)
  if (!active.find((p) => p.id === id)) return null
  setCurrentId(id)
  return {
    profiles: active,
    deletedProfiles: deletedOf(all),
    currentId: id,
    progress: loadProgress(id),
  }
}

export function updateProfile(id, updates) {
  const all = loadProfiles()
  const now = Date.now()
  const next = all.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: now } : p))
  saveProfiles(next)
  return { profiles: activeOf(next), deletedProfiles: deletedOf(next) }
}

// Soft delete: keep the profile (and its progress) so it can be restored.
export function deleteProfile(id) {
  const all = loadProfiles()
  const active = activeOf(all)
  const target = all.find((p) => p.id === id)
  if (!target || isDeleted(target)) return null
  if (active.length <= 1) return null // can't delete the last remaining profile

  const now = Date.now()
  const next = all.map((p) => (p.id === id ? { ...p, deletedAt: now, updatedAt: now } : p))
  saveProfiles(next)

  const nextActive = activeOf(next)
  let currentId = getCurrentId()
  if (!currentId || currentId === id || !nextActive.find((p) => p.id === currentId)) {
    currentId = nextActive[0].id
    setCurrentId(currentId)
  }

  return {
    profiles: nextActive,
    deletedProfiles: deletedOf(next),
    currentId,
    progress: loadProgress(currentId),
  }
}

// Bring back a soft-deleted profile and switch to it.
export function restoreProfile(id) {
  const all = loadProfiles()
  const target = all.find((p) => p.id === id)
  if (!target || !isDeleted(target)) return null

  const now = Date.now()
  const next = all.map((p) => {
    if (p.id !== id) return p
    const { deletedAt, ...rest } = p
    void deletedAt
    return { ...rest, updatedAt: now }
  })
  saveProfiles(next)
  setCurrentId(id)

  return {
    profiles: activeOf(next),
    deletedProfiles: deletedOf(next),
    currentId: id,
    progress: loadProgress(id),
  }
}

export { PROFILES_KEY, CURRENT_KEY, PROGRESS_PREFIX }
