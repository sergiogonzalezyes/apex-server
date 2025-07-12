export function parseSessions(rawInput) {
  const sessions = Array.isArray(rawInput) ? rawInput : [rawInput];
  const parsedSessions = [];

  for (const session of sessions) {
    const player = session.players?.[0];

    const track = session.track || null;
    const car = player?.car || null;
    const username = player?.name || null;
    const laps = session.sessions?.[0]?.laps || [];

    if (!track || !car || !username) {
      console.warn('⚠️ Incomplete session data:', { track, car, username });
      continue;
    }

    parsedSessions.push({
      track,
      car,
      username,
      laps: laps.map(lap => ({
        time: lap.time,
        valid: lap.valid ?? 1,
        sectors: lap.sectors ?? []
      }))
    });
  }

  return parsedSessions;
}
