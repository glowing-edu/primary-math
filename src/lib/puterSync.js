// Puter.js sync for Primary Math.
// Stores every child's progress in the signed-in user's own Puter space.

import { PROFILES_KEY, CURRENT_KEY, PROGRESS_PREFIX, normalizeProgress } from './profiles.js'

const PUTER_KEY = 'primary-math-profiles-backup-v1'
const SYNC_STATE_KEY = 'primary-math-puter-sync-state'

function profileTimestamp(profile) {
  if (!profile) return 0
  return profile.updatedAt || profile.deletedAt || profile.createdAt || 0
}

export function isPuterAvailable() {
  return typeof window !== 'undefined' && typeof window.puter !== 'undefined'
}

export async function isSignedIn() {
  if (!isPuterAvailable()) return false
  try {
    return await window.puter.auth.isSignedIn()
  } catch {
    return false
  }
}

export async function getUser() {
  if (!isPuterAvailable()) return null
  try {
    return await window.puter.auth.getUser()
  } catch {
    return null
  }
}

export async function signIn() {
  if (!isPuterAvailable()) throw new Error('Puter not available')
  return window.puter.auth.signIn()
}

export async function signOut() {
  if (!isPuterAvailable()) return
  try {
    await window.puter.auth.signOut()
  } catch {
    // ignore
  }
}

// Strict read: returns null only when the key genuinely does not exist.
// Network/auth/parse errors are thrown so they can never be mistaken for an
// empty cloud (which would let a push overwrite real cloud data).
async function readKey(key) {
  if (!isPuterAvailable()) throw new Error('Puter not available')
  const data = await window.puter.kv.get(key)
  if (data === null || data === undefined) return null
  if (typeof data === 'string') {
    try {
      return JSON.parse(data)
    } catch {
      throw new Error('Cloud data is not valid JSON; refusing to overwrite it')
    }
  }
  return data
}

async function writeKey(key, value) {
  if (!isPuterAvailable()) throw new Error('Puter not available')
  await window.puter.kv.set(key, value)
  return true
}

export async function loadFromPuter() {
  const data = await readKey(PUTER_KEY)
  if (data === null) return null
  if (typeof data !== 'object' || !Array.isArray(data.profiles)) {
    throw new Error('Cloud data is invalid; refusing to overwrite it')
  }
  return data
}

// Write a snapshot to the cloud, but never drop a profile that is already
// there. Removing a profile must always be an explicit local action.
export async function saveToPuter(snapshot) {
  if (!isPuterAvailable()) throw new Error('Puter not available')
  if (!snapshot || !Array.isArray(snapshot.profiles)) throw new Error('Invalid snapshot')
  if (snapshot.profiles.length === 0) {
    throw new Error('Refusing to write an empty profile list to the cloud')
  }

  const existing = await loadFromPuter()
  if (existing) {
    const nextIds = new Set(snapshot.profiles.map((p) => p.id))
    const missing = existing.profiles.filter((p) => !nextIds.has(p.id))
    if (missing.length > 0) {
      const names = missing.map((p) => p.name || p.id).join('、')
      throw new Error(`Refusing to remove cloud profiles: ${names}`)
    }
  }

  await writeKey(PUTER_KEY, snapshot)
  return true
}

// Summary of what is currently in the cloud, for the sync panel.
export async function getCloudSummary() {
  const snapshot = await loadFromPuter()
  if (!snapshot) return null
  const active = snapshot.profiles.filter((p) => !p.deletedAt)
  return {
    updatedAt: snapshot.updatedAt || 0,
    profiles: active.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar })),
    deletedCount: snapshot.profiles.length - active.length,
  }
}

// Create a snapshot from the current localStorage state.
export function createSnapshot() {
  try {
    const profilesRaw = localStorage.getItem(PROFILES_KEY)
    const profiles = profilesRaw ? JSON.parse(profilesRaw) : []
    const currentId = localStorage.getItem(CURRENT_KEY)

    const progress = {}
    for (const p of profiles) {
      const raw = localStorage.getItem(PROGRESS_PREFIX + p.id)
      if (raw) {
        try {
          progress[p.id] = normalizeProgress(JSON.parse(raw))
        } catch {
          // skip an unreadable single profile rather than lose everything
        }
      }
    }

    return {
      schema: 1,
      app: 'primary-math',
      updatedAt: Date.now(),
      profiles,
      progress,
      currentId,
    }
  } catch (err) {
    console.error('Failed to create snapshot:', err)
    return null
  }
}

function num(value) {
  return Math.max(0, Number(value) || 0)
}

// Merge progress for the same profile ID from two devices. Counters take the
// higher value so nothing earned on either device is lost.
export function mergeProgress(localProg, cloudProg) {
  const local = normalizeProgress(localProg)
  const cloud = normalizeProgress(cloudProg)

  const stages = {}
  for (const id of new Set([...Object.keys(local.stages), ...Object.keys(cloud.stages)])) {
    const a = local.stages[id] || { correct: 0, attempts: 0 }
    const b = cloud.stages[id] || { correct: 0, attempts: 0 }
    stages[id] = {
      correct: Math.max(a.correct, b.correct),
      attempts: Math.max(a.attempts, b.attempts),
    }
  }

  // The profile whose progress was touched most recently decides the stage.
  const newer = local.updatedAt >= cloud.updatedAt ? local : cloud

  return {
    score: Math.max(local.score, cloud.score),
    correct: Math.max(local.correct, cloud.correct),
    attempts: Math.max(local.attempts, cloud.attempts),
    stages,
    lastStage: newer.lastStage,
    updatedAt: Math.max(local.updatedAt, cloud.updatedAt),
  }
}

// Merge local into cloud. The cloud is always the base, so no cloud profile
// can ever be dropped by an upload.
export function mergeSnapshotsForUpload(localSnapshot, cloudSnapshot) {
  if (!cloudSnapshot) return localSnapshot
  if (!localSnapshot) return cloudSnapshot

  const result = {
    schema: 1,
    app: 'primary-math',
    updatedAt: Date.now(),
    profiles: [...(cloudSnapshot.profiles || [])],
    progress: JSON.parse(JSON.stringify(cloudSnapshot.progress || {})),
    currentId: cloudSnapshot.currentId,
  }

  const cloudProfileMap = new Map()
  const cloudProfileIndex = new Map()
  result.profiles.forEach((p, i) => {
    cloudProfileMap.set(p.id, p)
    cloudProfileIndex.set(p.id, i)
  })

  for (const localProfile of localSnapshot.profiles || []) {
    if (cloudProfileMap.has(localProfile.id)) {
      const idx = cloudProfileIndex.get(localProfile.id)
      if (profileTimestamp(localProfile) > profileTimestamp(result.profiles[idx])) {
        result.profiles[idx] = { ...localProfile }
      }
      const localProg = localSnapshot.progress[localProfile.id]
      const cloudProg = result.progress[localProfile.id]
      if (localProg && cloudProg) {
        result.progress[localProfile.id] = mergeProgress(localProg, cloudProg)
      } else if (localProg && !cloudProg) {
        result.progress[localProfile.id] = localProg
      }
    } else if (!localProfile.deletedAt) {
      // New active profile not in the cloud - add it. A profile deleted locally
      // that never existed in the cloud is not uploaded.
      cloudProfileMap.set(localProfile.id, localProfile)
      cloudProfileIndex.set(localProfile.id, result.profiles.length)
      result.profiles.push({ ...localProfile })
      if (localSnapshot.progress[localProfile.id]) {
        result.progress[localProfile.id] = localSnapshot.progress[localProfile.id]
      }
    }
  }

  return result
}

function getFingerprint(snapshot) {
  if (!snapshot) return null
  try {
    return JSON.stringify([snapshot.profiles, snapshot.progress])
  } catch {
    return null
  }
}

function readLocal() {
  const rawProfiles = localStorage.getItem(PROFILES_KEY)
  const profiles = rawProfiles ? JSON.parse(rawProfiles) : []
  const progress = {}
  for (const p of profiles) {
    const raw = localStorage.getItem(PROGRESS_PREFIX + p.id)
    if (raw) {
      try {
        progress[p.id] = normalizeProgress(JSON.parse(raw))
      } catch {
        // ignore
      }
    }
  }
  return { profiles, progress }
}

// Write a snapshot into localStorage.
//   preserveLocalAsNew = true  -> merge: cloud is the base, local-only profiles
//                                 and progress are kept too.
//   preserveLocalAsNew = false -> replace: local becomes exactly the snapshot.
export function applySnapshotToLocal(cloudSnapshot, preserveLocalAsNew = true) {
  if (!cloudSnapshot || !Array.isArray(cloudSnapshot.profiles) || cloudSnapshot.profiles.length === 0) {
    return { ok: false, changed: false }
  }

  try {
    const before = getFingerprint(createSnapshot())
    const local = readLocal()

    let profiles
    let progress
    let currentId

    if (!preserveLocalAsNew || local.profiles.length === 0) {
      profiles = cloudSnapshot.profiles.map((p) => ({ ...p }))
      progress = JSON.parse(JSON.stringify(cloudSnapshot.progress || {}))
      currentId = cloudSnapshot.currentId
    } else {
      profiles = cloudSnapshot.profiles.map((p) => ({ ...p }))
      progress = JSON.parse(JSON.stringify(cloudSnapshot.progress || {}))
      currentId = cloudSnapshot.currentId

      const cloudProfileMap = new Map()
      const cloudProfileIndex = new Map()
      profiles.forEach((p, i) => {
        cloudProfileMap.set(p.id, p)
        cloudProfileIndex.set(p.id, i)
      })

      for (const localProfile of local.profiles) {
        if (cloudProfileMap.has(localProfile.id)) {
          const idx = cloudProfileIndex.get(localProfile.id)
          if (profileTimestamp(localProfile) > profileTimestamp(profiles[idx])) {
            profiles[idx] = { ...localProfile }
          }
          const localProg = local.progress[localProfile.id]
          const cloudProg = progress[localProfile.id]
          if (localProg && cloudProg) {
            progress[localProfile.id] = mergeProgress(localProg, cloudProg)
          } else if (localProg && !cloudProg) {
            progress[localProfile.id] = localProg
          }
        } else {
          profiles.push(localProfile)
          if (local.progress[localProfile.id]) {
            progress[localProfile.id] = local.progress[localProfile.id]
          }
        }
      }
    }

    // Drop progress belonging to profiles that are no longer around.
    const keep = new Set(profiles.map((p) => p.id))
    for (const id of Object.keys(progress)) {
      if (!keep.has(id)) delete progress[id]
    }

    // Never leave the selection on a deleted profile.
    const currentRecord = profiles.find((p) => p.id === currentId)
    if (!currentId || !keep.has(currentId) || currentRecord?.deletedAt) {
      currentId = profiles.find((p) => !p.deletedAt)?.id || profiles[0].id
    }

    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
    if (currentId && keep.has(currentId)) {
      localStorage.setItem(CURRENT_KEY, currentId)
    } else {
      localStorage.setItem(CURRENT_KEY, profiles[0].id)
    }
    for (const p of profiles) {
      const prog = progress[p.id]
      if (prog) localStorage.setItem(PROGRESS_PREFIX + p.id, JSON.stringify(normalizeProgress(prog)))
    }
    // Remove stale per-profile progress keys.
    for (const localProfile of local.profiles) {
      if (!keep.has(localProfile.id)) {
        localStorage.removeItem(PROGRESS_PREFIX + localProfile.id)
      }
    }

    const after = getFingerprint(createSnapshot())
    return { ok: true, changed: before !== after }
  } catch (err) {
    console.error('Failed to apply snapshot:', err)
    return { ok: false, changed: false }
  }
}

export function getSyncState() {
  try {
    const raw = localStorage.getItem(SYNC_STATE_KEY)
    return raw ? JSON.parse(raw) : { lastCloudUpdatedAt: null, lastLocalFingerprint: null }
  } catch {
    return { lastCloudUpdatedAt: null, lastLocalFingerprint: null }
  }
}

function saveSyncState(state) {
  try {
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

// Sync with the cloud.
//
//   push: false  -> pull only. Cloud is merged into this device; the cloud is
//                   never written. Used for automatic sync on load.
//   push: true   -> two-way: merge local into the cloud, then bring the merged
//                   result back down locally. Cloud profiles are never dropped.
//   force: true  -> ignore the timestamp shortcut and sync anyway.
export async function smartSync({ push = true, force = false } = {}) {
  if (!isPuterAvailable()) throw new Error('Puter not available')
  if (!(await isSignedIn())) throw new Error('Not signed in')

  const localSnapshot = createSnapshot()
  if (!localSnapshot) throw new Error('Failed to create local snapshot')

  const localFingerprint = getFingerprint(localSnapshot)
  const syncState = getSyncState()

  const cloudSnapshot = await loadFromPuter()

  if (!cloudSnapshot) {
    if (!push) return { action: 'none', changed: false }
    if (localSnapshot.profiles.length === 0) {
      throw new Error('Refusing to create an empty cloud profile list')
    }
    // Confirmed missing cloud - this device seeds it.
    await saveToPuter(localSnapshot)
    saveSyncState({
      lastCloudUpdatedAt: localSnapshot.updatedAt,
      lastLocalFingerprint: localFingerprint,
    })
    return { action: 'uploaded', changed: false }
  }

  const cloudUpdatedAt = cloudSnapshot.updatedAt || 0

  if (!push) {
    // Automatic, non-destructive sync: download if the cloud changed.
    if (!force && cloudUpdatedAt === syncState.lastCloudUpdatedAt) {
      return { action: 'none', changed: false }
    }
    const result = applySnapshotToLocal(cloudSnapshot, true)
    saveSyncState({
      lastCloudUpdatedAt: cloudUpdatedAt,
      lastLocalFingerprint: getFingerprint(createSnapshot()),
    })
    return { action: result.ok ? 'downloaded' : 'error', changed: result.changed }
  }

  if (
    !force &&
    cloudUpdatedAt === syncState.lastCloudUpdatedAt &&
    localFingerprint === syncState.lastLocalFingerprint
  ) {
    return { action: 'none', changed: false }
  }

  const merged = mergeSnapshotsForUpload(localSnapshot, cloudSnapshot)
  // Keep this device's current selection if it survived the merge.
  const localCurrent = merged.profiles.find((p) => p.id === localSnapshot.currentId)
  if (localCurrent && !localCurrent.deletedAt) {
    merged.currentId = localCurrent.id
  } else if (!merged.profiles.find((p) => p.id === merged.currentId && !p.deletedAt)) {
    merged.currentId = merged.profiles.find((p) => !p.deletedAt)?.id || merged.profiles[0]?.id
  }
  await saveToPuter(merged)
  // Bring cloud-only profiles/progress back to this device as well. Merge
  // (rather than replace) so a local-only profile can never be dropped here.
  const result = applySnapshotToLocal(merged, true)
  saveSyncState({
    lastCloudUpdatedAt: merged.updatedAt,
    lastLocalFingerprint: getFingerprint(createSnapshot()),
  })
  return { action: 'merged', changed: result.changed }
}
