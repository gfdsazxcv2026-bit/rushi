/** Event phases distinguish moments that share the same historical year. */
export const momentOf = scene => scene?.momentId || `${scene?.chapterId}:${scene?.year}`;

export function isFromFuture(record, scene) {
  if (!Number.isFinite(record?.year) || !Number.isFinite(scene?.year)) return false;
  if (record.year !== scene.year) return record.year > scene.year;
  return Number.isFinite(record.momentOrder) && Number.isFinite(scene.momentOrder) && record.momentOrder > scene.momentOrder;
}
