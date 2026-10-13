import { DataSourceService } from "@furca/core/datasources/DataSourceService";
import { WarehouseTester } from "@furca/core/datasources/WarehouseTester";
import { authed } from "../Runtime/orpc";

export const dataSourcesRouter = {
  list: authed.dataSources.list.effect(function* () {
    return yield* (yield* DataSourceService).list;
  }),
  get: authed.dataSources.get.effect(function* (_opts, { id }) {
    return yield* (yield* DataSourceService).get(id);
  }),
  createBigQuery: authed.dataSources.createBigQuery.effect(function* ({ context }, input) {
    return yield* (yield* DataSourceService).createBigQuery(input, context.user);
  }),
  update: authed.dataSources.update.effect(function* ({ context }, input) {
    return yield* (yield* DataSourceService).update(input, context.user);
  }),
  delete: authed.dataSources.delete.effect(function* ({ context }, { id }) {
    yield* (yield* DataSourceService)
      .delete(id, context.user);
  }),
  test: authed.dataSources.test.effect(function* (_opts, { id }) {
    const source = yield* (yield* DataSourceService).get(id);
    return yield* (yield* WarehouseTester).test(source);
  }),
};
