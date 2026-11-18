import type { Repository } from "./contracts";
import type { AppOptions } from "./options";

const thresholdSince = new WeakMap<Repository, Map<string, number>>();

export function tickRepository(repository: Repository, options: AppOptions, now = Date.now()) {
  let crossings = thresholdSince.get(repository);
  if (!crossings) {
    crossings = new Map();
    thresholdSince.set(repository, crossings);
  }
  const activeKeys = new Set<string>();
  for (const session of repository.activeSessions()) {
    const key = `${session.guildId}/${session.sessionId}`;
    activeKeys.add(key);
    if (session.state === "starting") continue;
    let stats = repository.pendingStats(session);
    if (session.state === "stopping") {
      repository.createShortJob(session, true, now);
      if (!repository.hasPendingJobs(session)) {
        repository.createLongJob(session, true, now);
        if (!repository.hasPendingJobs(session)) {
          repository.setSessionState(session, "ended", now);
        }
      }
      continue;
    }

    const short = options.summary.short;
    if (stats.characters >= short.characterThreshold) {
      if (!crossings.has(key)) crossings.set(key, now);
    } else {
      crossings.delete(key);
    }
    const crossing = crossings.get(key);
    const charactersReady = crossing !== undefined && now - crossing >= short.debounceSeconds * 1000;
    const elapsedReady = now - stats.lastShortAt >= short.elapsedSeconds * 1000;
    const silenceReady = stats.lastAt !== null && now - stats.lastAt >= short.silenceSeconds * 1000;
    if (stats.characters > 0 && (charactersReady || elapsedReady || silenceReady)) {
      if (repository.createShortJob(session, false, now)) crossings.delete(key);
    }
    stats = repository.pendingStats(session);
    const long = options.summary.long;
    if (stats.shortCount > 0 &&
      (stats.shortCount >= long.newShortSummaryThreshold || now - stats.lastLongAt >= long.elapsedSeconds * 1000)) {
      repository.createLongJob(session, false, now);
    }
  }
  for (const key of crossings.keys()) {
    if (!activeKeys.has(key)) crossings.delete(key);
  }
}
