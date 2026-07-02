import repoOperationWorker from "./worker-repo-operation.js";

export default {
  async fetch(request, env, ctx) {
    return await repoOperationWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await repoOperationWorker.scheduled(event, env, ctx);
  }
};
