/**
 * Devolve o controlo ao browser (próxima tarefa) para evitar "página não responde".
 */
export async function yieldToMain() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  await new Promise((r) => setTimeout(r, 4));
}
