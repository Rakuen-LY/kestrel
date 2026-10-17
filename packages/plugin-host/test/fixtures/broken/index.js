export default {
  name: "fixture-broken",
  apply() {
    throw new Error("intentional failure");
  },
};
