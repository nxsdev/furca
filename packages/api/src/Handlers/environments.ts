import { EnvironmentService } from "@kuji/core/environments/EnvironmentService";
import { authed } from "../Runtime/orpc";

export const environmentsRouter = {
  list: authed.environments.list.effect(function* () {
    return yield* (yield* EnvironmentService).list;
  }),
  create: authed.environments.create.effect(function* ({ context }, input) {
    return yield* (yield* EnvironmentService).create(input, context.user);
  }),
  update: authed.environments.update.effect(function* ({ context }, input) {
    return yield* (yield* EnvironmentService).update(input, context.user);
  }),
  rotateSdkKey: authed.environments.rotateSdkKey.effect(function* ({ context }, { id }) {
    return yield* (yield* EnvironmentService).rotateSdkKey(id, context.user);
  }),
  delete: authed.environments.delete.effect(function* ({ context }, { id }) {
    yield* (yield* EnvironmentService)
      .delete(id, context.user);
  }),
  payload: authed.environments.payload.effect(function* (_opts, { id }) {
    return yield* (yield* EnvironmentService).payload(id);
  }),
};
