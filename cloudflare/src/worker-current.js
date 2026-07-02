import appWorker from "./worker-level-sync.js";

export default {
  async fetch(request, env, ctx) {
    return await appWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await appWorker.scheduled(event, env, ctx);
  }
};
