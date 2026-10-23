// Candidate strategy template. Copy to research/candidates/<id>.js and fill in create().
// Works in Node (module.exports) and the browser (window.Candidates[id]).
(function (root) {
  "use strict";
  function create(params) {
    // State kept across days/years lives in this closure.
    return {
      // Called once per calendar year at the previous close (ctx.now = last day of prior year).
      // Use it to select pairs / fit models on history up to ctx.now.
      form(ctx) {},
      // Called every trading day at the close (ctx.now = today). Return a {symbol: weight} map
      // (weights are fractions of equity; + long, - short; gross is capped at 1) to trade at
      // today's close, or null to keep the current positions (they drift with prices).
      weights(ctx) { return null; },
    };
  }
  const def = {
    id: "template",
    name: "Template",
    short: "Template",
    description: "One or two sentences a non-quant can understand.",
    defaults: {},
    create,
  };
  if (typeof module === "object" && module.exports) module.exports = def;
  else (root.Candidates = root.Candidates || {})[def.id] = def;
})(typeof window !== "undefined" ? window : globalThis);
