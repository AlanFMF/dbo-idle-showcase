export const RESPAWN_DELAY_MS = 10_000;

export function scheduleDeath(slot, now, delay = RESPAWN_DELAY_MS) {
  return {
    ...slot,
    alive:false,
    hp:0,
    respawnAt:Number(now) + Number(delay)
  };
}

export function isRespawnReady(slot, now) {
  return (
    !slot.alive &&
    Number.isFinite(Number(slot.respawnAt)) &&
    Number(now) >= Number(slot.respawnAt)
  );
}

export function reconcileSlots(slots, desired, now) {
  const result = [...slots];
  while (result.length < desired) {
    const index = result.length;
    result.push({
      slotIndex:index,
      alive:false,
      hp:0,
      respawnAt:Number(now) + RESPAWN_DELAY_MS + index * 700
    });
  }

  return result.map((slot, index) => {
    if (slot.alive || index >= desired) return slot;
    const timer = Number(slot.respawnAt);
    return {
      ...slot,
      slotIndex:index,
      respawnAt:
        Number.isFinite(timer) && timer > 0
          ? timer
          : Number(now) + RESPAWN_DELAY_MS
    };
  });
}
