import readyWorker from "./worker-github-ready.js";

export default {
  async fetch(request, env, ctx) {
    return await readyWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await readyWorker.scheduled(event, env, ctx);
  }
};
