// TypeScript Version: 4.0
import { Params, Paginated, Id, NullableId, Hook, ServiceMethods } from '@feathersjs/feathers';
import { InternalServiceMethods, AdapterParams, AdapterBase, AdapterServiceOptions, PaginationOptions, AdapterQuery } from '@feathersjs/adapter-commons';
import { Model, Document, Query, ClientSession } from 'mongoose';

export namespace hooks {
  function toObject(options?: any, dataField?: string): Hook;
}

export namespace transactionManager {
  const beginTransaction: Hook;
  const commitTransaction: Hook;
  const rollbackTransaction: Hook;
}

export interface MongooseServiceOptions<T extends Document = any> extends AdapterServiceOptions {
  Model: Model<T>;
  lean?: boolean;
  overwrite?: boolean;
  useEstimatedDocumentCount?: boolean;
  queryModifier?: (query: Query<any, any>, params: Params) => void;
  queryModifierKey?: string;
}

export interface MongooseAdapterParams<Q = AdapterQuery> extends AdapterParams<Q, Partial<MongooseServiceOptions>> {
  mongoose?: {
    [key: string]: any;
    session?: ClientSession;
  }
}

export class MongooseDbAdapter <T, D = Partial<T>, P extends MongooseAdapterParams = MongooseAdapterParams> extends AdapterBase<T, D, P, MongooseServiceOptions> {
  async $get(id: Id, params: P = {} as P): Promise<T>;

  async $find(params?: P & { paginate?: PaginationOptions }): Promise<Paginated<T>>;
  async $find(params?: P & { paginate: false }): Promise<T[]>;
  async $find(params?: P): Promise<Paginated<T>|T[]>;
  async $find(params: P = {} as P): Promise<Paginated<T>|T[]>;

  async $create(data: Partial<D>, params?: P): Promise<T>;
  async $create(data: Partial<D>[], params?: P): Promise<T[]>;
  async $create(data: Partial<D>|Partial<D>[], _params?: P): Promise<T|T[]>;
  async $create(data: Partial<D>|Partial<D>[], params: P = {} as P): Promise<T|T[]>;

  async $patch(id: null, data: Partial<D>, params?: P): Promise<T[]>;
  async $patch(id: Id, data: Partial<D>, params?: P): Promise<T>;
  async $patch(id: NullableId, data: Partial<D>, _params?: P): Promise<T|T[]>;
  async $patch(id: NullableId, _data: Partial<D>, params: P = {} as P): Promise<T|T[]>;

  async $update(id: Id, data: D, params: P = {} as P): Promise<T>;

  async $remove(id: null, params?: P): Promise<T[]>;
  async $remove(id: Id, params?: P): Promise<T>;
  async $remove(id: NullableId, _params?: P): Promise<T|T[]>;
  async $remove(id: NullableId, params: P = {} as P): Promise<T|T[]>;
}

export class Service<T = any, D = Partial<T>, P extends MongooseAdapterParams = MongooseAdapterParams>
  extends MongooseDbAdapter<T, D, P> implements ServiceMethods<T|Paginated<T>, D, P> {
  Model: Model<Document>;
  options: MongooseServiceOptions<Document>;

  async find(params?: P & { paginate?: PaginationOptions }): Promise<Paginated<T>>;
  async find(params?: P & { paginate: false }): Promise<T[]>;
  async find(params?: P): Promise<Paginated<T>|T[]>;

  async get(id: Id, params?: P): Promise<T>;

  async create(data: Partial<D>, params?: P): Promise<T>;
  async create(data: Partial<D>[], params?: P): Promise<T[]>;
  async create(data: Partial<D>|Partial<D>[], params?: P): Promise<T|T[]>;

  async update(id: Id, data: D, params?: P): Promise<T>;

  async patch(id: Id, data: Partial<D>, params?: P): Promise<T>;
  async patch(id: null, data: Partial<D>, params?: P): Promise<T[]>;
  async patch(id: NullableId, data: Partial<D>, params?: P): Promise<T | T[]>;

  async remove(id: Id, params?: P): Promise<T>;
  async remove(id: null, params?: P): Promise<T[]>;
  async remove(id: NullableId, params?: P): Promise<T | T[]>;
}

declare const mongoose: ((config?: Partial<MongooseServiceOptions>) => Service);
export default mongoose;
