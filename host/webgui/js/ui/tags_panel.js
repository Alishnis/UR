// Mission 2.1 side panel: assigned rule, reset / undo, CLAHE, confirmed tags and the answer.
export class TagsPanel {
  constructor(rootEl, client) {
    this.client = client;
    this.el = {
      largest: rootEl.querySelector("#rule-largest"),
      smallest: rootEl.querySelector("#rule-smallest"),
      reset: rootEl.querySelector("#tags-reset"),
      undo: rootEl.querySelector("#tags-undo"),
      clahe: rootEl.querySelector("#tags-clahe"),
      expected: rootEl.querySelector("#tags-expected"),
      list: rootEl.querySelector("#vision-list"),
      seen: rootEl.querySelector("#vision-seen"),
      selected: rootEl.querySelector("#vision-selected"),
    };
    this.el.largest.addEventListener("click", () => client.command("rule", { rule: "largest" }));
    this.el.smallest.addEventListener("click", () => client.command("rule", { rule: "smallest" }));
    this.el.reset.addEventListener("click", () => {
      if (confirm("Forget all tags found in this attempt?")) client.command("reset");
    });
    this.el.undo.addEventListener("click", () => client.command("undo"));
    this.el.clahe.addEventListener("change", () => client.command("clahe", { on: this.el.clahe.checked }));
    this.el.expected.addEventListener("change", () => client.command("expected", { n: Number(this.el.expected.value) }));
  }

  update(state) {
    if (!state || !state.confirmed) return;
    this.el.largest.classList.toggle("active", state.rule === "largest");
    this.el.smallest.classList.toggle("active", state.rule === "smallest");
    this.el.clahe.checked = state.clahe;
    if (document.activeElement !== this.el.expected) this.el.expected.value = state.expected;
    const n = state.confirmed.length;
    this.el.list.textContent = n ? `${n}/${state.expected}: ${state.confirmed.join(", ")}` : `0/${state.expected}: none yet`;
    this.el.list.dataset.state = n === state.expected ? "ok" : n > state.expected ? "bad" : "warn";
    if (state.detections) {
      this.el.seen.textContent = state.detections.length
        ? "in view: " + state.detections.map((d) => `${d.id} (m ${Math.round(d.margin)})`).join(", ")
        : "in view: -";
    }
    let answer = "---", s = "idle";
    if (!state.rule) { answer = "set the rule"; s = "bad"; }
    else if (state.selected !== null && state.selected !== undefined) { answer = `ID ${state.selected}`; s = "ok"; }
    else if (n > state.expected) { answer = "??? undo the false tag"; s = "bad"; }
    else if (state.best_so_far !== null) { answer = `--- (best so far ${state.best_so_far})`; s = "warn"; }
    this.el.selected.textContent = answer;
    this.el.selected.dataset.state = s;
  }
}
