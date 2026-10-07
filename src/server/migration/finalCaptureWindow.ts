/* Local orchestration seam only. A caller-supplied control reader cannot prove
 * deployment-wide exclusion, including human Sheets editors. Never use this
 * result as a cutover, final-import, or approval capability. */
export async function captureFinalCandidateWindow<T>(
  readState: () => Promise<{ generation: number; disabled: boolean }>,
  capture: () => Promise<T>,
): Promise<{ authority: 'NONAUTHORITY'; exclusion: 'NOT_PROVEN'; generation: number; candidate: T }> {
  const valid = (state: { generation: number; disabled: boolean }) => state
    && Number.isSafeInteger(state.generation) && state.generation > 0 && state.disabled === true;
  try {
    const before = await readState();
    if (!valid(before)) throw new Error('Invalid starting control state.');
    const generation = before.generation;
    const candidate = await capture();
    const after = await readState();
    if (!valid(after) || generation !== after.generation) throw new Error('Control state changed.');
    return Object.freeze({ authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', generation, candidate });
  } catch {
    throw new Error('Final capture window refused.');
  }
}
