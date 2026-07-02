import appWorker from "./worker-patch-dialog.js";

export default {
  async fetch(request, env, ctx) {
    return await appWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await appWorker.scheduled(event, env, ctx);
  }
};
