/** Tiny DOM-builder helper so the vanilla-JS UI modules don't turn into innerHTML soup. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "html") {
      node.innerHTML = value;
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function field(labelText, inputNode) {
  return el("label", { class: "field" }, [el("span", { class: "field-label", text: labelText }), inputNode]);
}

export function numberInput(value, onChange, { min, max, step = 1 } = {}) {
  const input = el("input", { type: "number", value, min, max, step });
  input.addEventListener("input", () => onChange(Number(input.value)));
  return input;
}

export function colorInput(value, onChange) {
  const input = el("input", { type: "color", value });
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

export function checkboxInput(checked, onChange) {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

export function selectInput(value, options, onChange) {
  const select = el("select", {});
  for (const opt of options) {
    const optionEl = el("option", { value: opt.value, text: opt.label });
    if (opt.value === value) optionEl.selected = true;
    select.appendChild(optionEl);
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

export function rangeInput(value, onChange, { min, max, step = 1 } = {}) {
  const input = el("input", { type: "range", value, min, max, step });
  input.addEventListener("input", () => onChange(Number(input.value)));
  return input;
}
