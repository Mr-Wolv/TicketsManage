export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    if (this.map.has(key)) {
      const value = this.map.get(key)!;
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }
    return undefined;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value!;
      this.map.delete(firstKey);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
