// Sliders for one filter set. `copySource` adds a button that copies another set (e.g. "same as pilot view").
const SLIDERS = [
  ["brightness", 0.1, 3.0, 0.01],
  ["contrast", 0.1, 3.0, 0.01],
  ["saturation", 0.0, 3.0, 0.01],
  ["hue", -180, 180, 1],
  ["blur", 0, 20, 0.1],
];

export class FilterPanel {
  constructor(rootEl, state, { copySource = null, copyLabel = "Copy", onChange = () => {} } = {}) {
    this.root = rootEl;
    this.state = state;
    this.onChange = onChange;
    this.inputs = {};
    this.values = {};
    for (const [key, min, max, step] of SLIDERS) this._slider(key, min, max, step);

    const row = document.createElement("div");
    row.className = "row";
    const reset = document.createElement("button");
    reset.textContent = "Reset";
    reset.addEventListener("click", () => { state.reset(); this.sync(); });
    row.appendChild(reset);
    if (copySource) {
      const copy = document.createElement("button");
      copy.textContent = copyLabel;
      copy.addEventListener("click", () => { state.copyFrom(copySource); this.sync(); });
      row.appendChild(copy);
    }
    this.root.appendChild(row);
    this.sync();
  }

  _slider(key, min, max, step) {
    const label = document.createElement("label");
    label.className = "filter";
    const name = document.createElement("span");
    name.textContent = key;
    const value = document.createElement("span");
    value.className = "value";
    const input = document.createElement("input");
    Object.assign(input, { type: "range", min, max, step });
    input.addEventListener("input", () => {
      this.state[key] = parseFloat(input.value);
      this.state.save();
      this._show(key);
      this.onChange();
    });
    input.addEventListener("dblclick", () => {  // double click = back to neutral for this slider
      this.state[key] = key === "hue" || key === "blur" ? 0 : 1;
      this.state.save();
      this.sync();
    });
    label.append(name, value, input);
    this.root.appendChild(label);
    this.inputs[key] = input;
    this.values[key] = value;
  }

  _show(key) {
    const v = this.state[key];
    this.values[key].textContent = key === "hue" ? `${v} deg` : key === "blur" ? `${v} px` : v.toFixed(2);
  }

  sync() {
    for (const key in this.inputs) {
      this.inputs[key].value = this.state[key];
      this._show(key);
    }
    this.onChange();
  }
}
