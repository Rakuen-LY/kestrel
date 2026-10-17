export default {
  name: "fixture-beta",
  version: "2.0.0",
  inject: ["alpha"],
  apply(context) {
    context.provide("beta", { alpha: context.get("alpha") });
  },
};
