/**
 * Runs tasks one at a time per key, in the order they were added. Different
 * keys run concurrently, so one buyer's slow reply never delays another's.
 */
export class KeyedQueue {
  #tails = new Map();

  run(key, task) {
    const tail = this.#tails.get(key) || Promise.resolve();
    const result = tail.then(task, task);
    const settled = result.then(() => {}, () => {});
    this.#tails.set(key, settled);
    settled.then(() => { if (this.#tails.get(key) === settled) this.#tails.delete(key); });
    return result;
  }

  get size() {
    return this.#tails.size;
  }
}
