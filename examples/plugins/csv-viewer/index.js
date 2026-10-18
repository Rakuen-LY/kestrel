/**
 * Server side of the csv-viewer example. The interesting half is `web/panel.js`:
 * this plugin exists to show that a browser contribution can replace how a
 * file is rendered without the console knowing anything about CSV.
 */
export default {
  name: "@example/plugin-csv-viewer",
  version: "0.1.0",
  description: "CSV table renderer for the console file viewer.",
  apply(context) {
    context.logger.info("csv viewer ready");
  },
};
