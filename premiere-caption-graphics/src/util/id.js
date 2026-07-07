let counter = 0;

export function nextId(prefix = "id") {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
