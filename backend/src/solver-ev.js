// An EV is only meaningful with its reference point. Calibrate against the
// provider's FOLD value, rather than assuming a convention or clamping losses.
export function numericEv(value) {
  if (!["number", "string"].includes(typeof value) || typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function readEvs(result, hand) {
  const values = Array.isArray(result?.evs) ? result.evs : result?.evs?.[hand] ?? result?.evs?.[hand.slice(2) + hand.slice(0, 2)];
  if (!Array.isArray(values) || !Array.isArray(result?.actions) || !result.actions.length) return null;
  return { actions: result.actions, values: result.actions.map((_, i) => numericEv(values[i])) };
}

export function foldEv(evs) {
  const index = evs?.actions?.findIndex(action => String(action).trim().toUpperCase() === "FOLD") ?? -1;
  return index < 0 ? null : numericEv(evs.values[index]);
}

export function normalizeDecisionEvs(evs, baseline = evs, baselineNode = "") {
  if (!evs) return null;
  const fold = foldEv(baseline);
  const rawValues = evs.values.map(numericEv);
  const offsetBb = fold === null ? null : -fold;
  return {
    actions: evs.actions,
    values: rawValues.map(value => value === null ? null : offsetBb === null ? value : value + offsetBb),
    rawValues,
    reference: offsetBb === null ? "provider" : "decision",
    offsetBb,
    baselineNode: offsetBb === null ? null : baselineNode
  };
}

export function bestEvAction(actions = [], values = []) {
  let action = "", ev = null;
  actions.forEach((name, index) => {
    const value = numericEv(values[index]);
    if (value !== null && (ev === null || value > ev)) { action = String(name).toLowerCase(); ev = value; }
  });
  return { action, ev };
}

// These adjacent nodes change only a zero-cost check and the opponent's bet.
// Hero has invested exactly the same amount, so FOLD establishes the same zero.
export function foldReferenceNodes(nodes, target) {
  const path = target.node.split("/");
  return nodes.filter(node => {
    if (!node.is_hero || node.node === target.node) return false;
    const candidate = node.node.split("/");
    if (path.at(-1) === "CHECK" && candidate.length === path.length) {
      return candidate.slice(0, -1).join("/") === path.slice(0, -1).join("/") && /^BET \d/.test(candidate.at(-1));
    }
    return candidate.length === path.length + 2 && candidate.slice(0, -2).join("/") === target.node &&
      candidate.at(-2) === "CHECK" && /^BET \d/.test(candidate.at(-1));
  }).sort((a, b) => Number(a.node.split("/").at(-1).split(" ")[1]) - Number(b.node.split("/").at(-1).split(" ")[1]));
}
