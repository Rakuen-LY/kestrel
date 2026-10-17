export default {
  name: "fixture-alpha",
  version: "1.0.0",
  apply(context, config) {
    context.provide("alpha", { greeting: config.greeting });
    context.logger.info("alpha applied");
  },
};
