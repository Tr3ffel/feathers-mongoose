const { _ } = require('@feathersjs/commons');
const { AdapterBase, select, filterQuery } = require('@feathersjs/adapter-commons');
const errors = require('@feathersjs/errors');
const { Query } = require('mongoose');
const mongooseQuery = new Query();

const { ERROR, errorHandler } = require('./error-handler');

// Create the service.
class Service extends AdapterBase {
  constructor (options) {
    if (!options.Model || !options.Model.modelName) {
      throw new Error('You must provide a Mongoose Model');
    }

    const { operators = ['$regex'] } = options;

    super(Object.assign({
      id: '_id',
      filters: Object.assign(
        {
          $populate (value) {
            return value;
          },
          $and (value) {
            return value;
          }
        },
        options.filter
      ),
      queryModifierKey: 'queryModifier'
    }, options, {
      operators: operators.concat('$and')
    }));

    this.discriminatorKey = this.Model.schema.options.discriminatorKey;
    this.discriminators = {};
    (options.discriminators || []).forEach(element => {
      if (element.modelName) {
        this.discriminators[element.modelName] = element;
      }
    });
    this.lean = options.lean === undefined ? true : options.lean;
    this.overwrite = options.overwrite !== false;
    this.useEstimatedDocumentCount = !!options.useEstimatedDocumentCount;
  }

  get Model () {
    return this.options.Model;
  }

  filterQuery (params, opts) {
    const paginate = typeof params.paginate !== 'undefined'
      ? params.paginate
      : this.options.paginate;
    const { query = {} } = params;
    const options = Object.assign({
      operators: this.options.operators || [],
      filters: this.options.filters,
      paginate
    }, opts);
    const result = filterQuery(query, options);

    if (result?.filters?.$and) {
      result.query.$and = result.filters.$and;
    }

    if (result?.filters?.$or) {
      result.query.$or = result.filters.$or;
    }

    return Object.assign(result, { paginate });
  }

  $getQueryModifier (params) {
    if (typeof params[this.options.queryModifierKey] === 'function') {
      return params[this.options.queryModifierKey];
    }
    if (params[this.options.queryModifierKey] !== false) {
      if (typeof this.options.queryModifier === 'function') {
        return this.options.queryModifier;
      }
    }
    return () => {};
  }

  $getOrFind (id, params = {}) {
    if (id === null) {
      return this.$find(params);
    }

    return this.$get(id, params);
  }

  $findAggregate(params = {}) {
    const { aggregation = [], session } = params.mongoose || {};

    const { filters, query, paginate } = this.filterQuery(params);
    const discriminator = (params.query || {})[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;

    const aggregationPipeline = JSON.parse(JSON.stringify(aggregation));

    const modelExtendedByJoinedReferences =  {
      schema: model.schema.clone(),
      ...model,
    };
    const lookupPipes = aggregationPipeline.filter(pipe => pipe.$lookup);
    lookupPipes.forEach((pipe) => {
      if (pipe.$lookup.from && pipe.$lookup.localField) {
        const joinedModel = model.db.models[pipe.$lookup.from];
        if (joinedModel) {
          Object.keys(joinedModel.schema.paths).forEach(key => {
            modelExtendedByJoinedReferences.schema.paths[`${pipe.$lookup.localField}.${key}`] = joinedModel.schema.paths[key];
          })
        }
      }
    });

    if (query) {
      const matchPipeIndex = aggregationPipeline.findIndex(pipe => pipe.$match);
      if (matchPipeIndex !== -1) {
        conso
        aggregationPipeline[matchPipeIndex] = {
          $match: mongooseQuery.cast(modelExtendedByJoinedReferences, {
            ...aggregationPipeline[matchPipeIndex].$match,
            ...query,
          }),
        }
      } else {
        aggregationPipeline.push({
          $match: mongooseQuery.cast(modelExtendedByJoinedReferences, { ...query })
        });
      }
    }

    if (Array.isArray(filters.$select)) {
      if (filters.$select.length) {
        aggregationPipeline.push({
          $project: filters.$select.reduce((res, key) => Object.assign(res, {
            [key]: 1
          }), {})
        });
      }
    } else if (typeof filters.$select === 'string' || typeof filters.$select === 'object') {
      throw new Error('Only $select with array values are supported for aggreation');
    }

    if (filters.$sort) {
      aggregationPipeline.push({
        $sort: filters.$sort,
      });
    } else {
      aggregationPipeline.push({
        $sort: {
          _id: 1
        },
      });
    }

    if (filters.$skip) {
      aggregationPipeline.push({
        $skip: filters.$skip,
      });
    }

    if (typeof filters.$limit !== 'undefined') {
      aggregationPipeline.push({
        $limit: filters.$limit,
      });
    }

    const q = model.aggregate(aggregationPipeline);

    if (params.collation) {
      q.collation(params.collation);
    }

    if (filters.$populate && this.options.operators.includes('$populate')) {
      q.populate(filters.$populate);
    }

    let executeQuery = total => q.session(session).exec().then(data => {
      return {
        total,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data
      };
    });

    if (filters.$limit === 0) {
      executeQuery = total => Promise.resolve({
        total,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data: []
      });
    }

    if (paginate && paginate.default) {
      const countAggregation = aggregationPipeline.slice(0, aggregationPipeline.findIndex(pipe => pipe.$match) + 1);
      countAggregation.push({ $count: 'total' });
      return model.aggregate(countAggregation).session(session).exec().then((countResult) => {
        if (!countResult[0]?.total || countResult[0]?.total === 0) {
          return {
            total: 0,
            limit: filters.$limit,
            skip: filters.$skip || 0,
            data: []
          }
        } 
        return executeQuery(countResult[0]?.total);
      });
    }

    return executeQuery().then(page => page.data);
  }

  $find (params = {}) {
    if (Array.isArray(params?.mongoose?.aggregation)) {
      return this.$findAggregate(params);
    }

    const { filters, query, paginate } = this.filterQuery(params);
    const discriminator = (params.query || {})[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;

    const q = model.find(query).lean(this.lean);

    // $select uses a specific find syntax, so it has to come first.
    if (Array.isArray(filters.$select)) {
      q.select(filters.$select.reduce((res, key) => Object.assign(res, {
        [key]: 1
      }), {}));
    } else if (typeof filters.$select === 'string' || typeof filters.$select === 'object') {
      q.select(filters.$select);
    }

    // Handle $sort
    if (filters.$sort) {
      q.sort(filters.$sort);
    }

    // Handle collation
    if (params.collation) {
      q.collation(params.collation);
    }

    // Handle $limit
    if (typeof filters.$limit !== 'undefined') {
      q.limit(filters.$limit);
    }

    // Handle $skip
    if (filters.$skip) {
      q.skip(filters.$skip);
    }

    // Handle $populate
    if (filters.$populate && this.options.operators.includes('$populate')) {
      q.populate(filters.$populate);
    }

    this.$getQueryModifier(params)(q, params);

    let executeQuery = total => q.session(params.mongoose && params.mongoose.session).exec().then(data => {
      return {
        total,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data
      };
    });

    if (filters.$limit === 0) {
      executeQuery = total => Promise.resolve({
        total,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data: []
      });
    }

    if (paginate && paginate.default) {
      return model.where(query)[this.useEstimatedDocumentCount ? 'estimatedDocumentCount' : 'countDocuments']()
        .session(params.mongoose && params.mongoose.session).exec().then(executeQuery);
    }

    return executeQuery().then(page => page.data);
  }

  $getAggregate(id, params = {}) {
    const { aggregation = [], session } = params.mongoose || {};

    const { query, filters } = this.filterQuery(params);
    query.$and = (query.$and || []).concat([{ [this.id]: id }]);
    const discriminator = query[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;

    const aggregationPipeline = JSON.parse(JSON.stringify(aggregation));

    const modelExtendedByJoinedReferences =  {
      schema: model.schema.clone(),
      ...model,
    };
    const lookupPipes = aggregationPipeline.filter(pipe => pipe.$lookup);
    lookupPipes.forEach((pipe) => {
      if (pipe.$lookup.from && pipe.$lookup.localField) {
        const joinedModel = model.db.models[pipe.$lookup.from];
        if (joinedModel) {
          Object.keys(joinedModel.schema.paths).forEach(key => {
            modelExtendedByJoinedReferences.paths[`${pipe.$lookup.localField}.${key}`] = joinedModel.schema.paths[key];
          })
        }
      }
    });

    if (query) {
      const matchPipeIndex = aggregationPipeline.findIndex(pipe => pipe.$match);
      if (matchPipeIndex !== -1) {
        aggregationPipeline[matchPipeIndex] = {
          $match: mongooseQuery.cast(modelExtendedByJoinedReferences, {
            ...aggregationPipeline[matchPipeIndex].$match,
            ...query,
          })
        };
      } else {
        aggregationPipeline.push({
          $match: mongooseQuery.cast(modelSchemaExtendedByJoinedReferences, { ...query })
        });
      }
    }

    if (Array.isArray(filters.$select)) {
      if (filters.$select.length) {
        aggregationPipeline.push({
          $project: filters.$select.reduce((res, key) => Object.assign(res, {
            [key]: 1
          }), {})
        });
      }
    } else if (typeof filters.$select === 'string' || typeof filters.$select === 'object') {
      return Promise.reject(new errors.GeneralError('Only $select with array values are supported for aggreation'));
    }

    aggregationPipeline.push({
      $limit: 1,
    });

    const q = model.aggregate(aggregationPipeline);

    if (filters.$populate && this.options.operators.includes('$populate')) {
      q.populate(filters.$populate);
    }

    return q.session(session).exec().then(data => {
        const item = data[0];
        if (!item) {
          throw new errors.NotFound(`No record found for id '${id}'`);
        }
        return item;
      }).catch(errorHandler);
  }

  $get (id, params = {}) {
    if (Array.isArray(params?.mongoose?.aggregation)) {
      return this.$getAggregate(id, params);
    }

    const { query, filters } = this.filterQuery(params);

    query.$and = (query.$and || []).concat([{ [this.id]: id }]);

    const discriminator = query[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;
    let modelQuery = model.findOne(query);

    // Handle $populate
    if (filters.$populate && this.options.operators.includes('$populate')) {
      modelQuery = modelQuery.populate(filters.$populate);
    }

    // Handle $select
    if (filters.$select && filters.$select.length) {
      const fields = { [this.id]: 1 };

      for (const key of filters.$select) {
        fields[key] = 1;
      }

      modelQuery.select(fields);
    } else if (filters.$select && typeof filters.$select === 'object') {
      modelQuery.select(filters.$select);
    }

    this.$getQueryModifier(params)(modelQuery, params);

    return modelQuery.session(params.mongoose && params.mongoose.session)
      .lean(this.lean).exec().then(data => {
        if (!data) {
          throw new errors.NotFound(`No record found for id '${id}'`);
        }

        return data;
      }).catch(errorHandler);
  }

  $create (_data, params = {}) {
    const discriminator = (params.query || {})[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;
    const { query: { $populate } = {} } = params;
    const isMulti = Array.isArray(_data);
    const data = isMulti ? _data : [_data];

    return model.create(data, params.mongoose).then(results => {
      if (results === undefined) {
        return [];
      }
      if ($populate && this.options.operators.includes('$populate')) {
        return Promise.all(results.map(result => this.Model.populate(result, $populate)));
      }

      return results;
    }).then(results => {
      if (this.lean) {
        results = results.map(item => (item.toObject ? item.toObject() : item));
      }

      return isMulti ? results : results[0];
    }).then(select(params, this.id)).catch(errorHandler);
  }

  $update (id, data, params = {}) {
    if (id === null) {
      return Promise.reject(new errors.BadRequest('Not replacing multiple records. Did you mean `patch`?'));
    }

    if (params?.mongoose?.aggregation) {
      return Promise.reject(new errors.GeneralError('Aggregation is not supported on update method'));
    }

    // Handle case where data might be a mongoose model
    if (typeof data.toObject === 'function') {
      data = data.toObject();
    }

    const { query, filters } = this.filterQuery(params);
    const options = Object.assign({
      new: true,
      overwrite: this.overwrite,
      runValidators: true,
      context: 'query',
      setDefaultsOnInsert: true
    }, params.mongoose);

    query.$and = (query.$and || []).concat({ [this.id]: id });

    if (this.id === '_id') {
      // We can not update default mongo ids
      data = _.omit(data, this.id);
    } else {
      // If not using the default Mongo _id field set the id to its
      // previous value. This prevents orphaned documents.
      data = Object.assign({}, data, { [this.id]: id });
    }

    const discriminator = query[this.discriminatorKey] || this.discriminatorKey;
    const model = this.discriminators[discriminator] || this.Model;
    let modelQuery = model.findOneAndUpdate(query, data, options);

    if (filters.$populate && this.options.operators.includes('$populate')) {
      modelQuery = modelQuery.populate(filters.$populate);
    }

    return modelQuery.lean(this.lean).exec()
      .then(result => {
        if (result === null) {
          throw new errors.NotFound(`No record found for id '${id}'`);
        }

        return result;
      })
      .then(select(params, this.id)).catch(errorHandler);
  }

  $patch (id, data, params = {}) {
    const { query } = this.filterQuery(params);
    const mapIds = data => Array.isArray(data) ? data.map(current => current[this.id]) : [data[this.id]];

    // By default we will just query for the one id. For multi patch
    // we create a list of the ids of all items that will be changed
    // to re-query them after the update
    const ids = this.$getOrFind(id, Object.assign({}, params, {
      paginate: false
    })).then(mapIds);

    // Handle case where data might be a mongoose model
    if (typeof data.toObject === 'function') {
      data = data.toObject();
    }

    // ensure we are working on a copy
    data = Object.assign({}, data);

    // If we are updating multiple records
    const options = Object.assign({
      multi: id === null,
      runValidators: true,
      context: 'query'
    }, params.mongoose);

    if (id !== null) {
      query.$and = (query.$and || []).concat({ [this.id]: id });
    }

    if (this.id === '_id') {
      // We can not update default mongo ids
      delete data[this.id];
    } else if (id !== null) {
      // If not using the default Mongo _id field set the id to its
      // previous value. This prevents orphaned documents.
      data[this.id] = id;
    }

    // NOTE (EK): We need this shitty hack because update doesn't
    // return a promise properly when runValidators is true. WTF!
    try {
      return ids.then(idList => {
        const { query: { $populate } = {} } = params;
        // Create a new query that re-queries all ids that
        // were originally changed
        const updatedQuery = { [this.id]: { $in: idList } };
        const findParams = Object.assign({}, params, {
          paginate: false,
          query: $populate && this.options.operators.includes('$populate') ? Object.assign(updatedQuery, { $populate }) : updatedQuery
        });

        // If params.query.$populate was provided, remove it
        // from the query sent to mongoose.
        const discriminator = query[this.discriminatorKey] || this.discriminatorKey;
        const model = this.discriminators[discriminator] || this.Model;
        return model
          .updateMany(query, data, options)
          .lean(this.lean)
          .exec()
          .then(writeResult => {
            if (options.writeResult) {
              return writeResult;
            }
            if (writeResult.upsertedCount > 0) {
              return this.$getOrFind(id, Object.assign({}, params, { paginate: false }));
            }

            if ('upserted' in writeResult) {
              return this.$getOrFind(id, Object.assign({}, params, { query: { [this.id]: { $in: writeResult.upserted.map(doc => doc._id) } } }, { paginate: false }));
            }

            return this.$getOrFind(id, findParams);
          });
      }).then(select(params, this.id)).catch(errorHandler);
    } catch (e) {
      return errorHandler(e);
    }
  }

  $remove (id, params = {}) {
    const { query } = this.filterQuery(params);

    if (params.collation) {
      query.collation = params.collation;
    }

    const findParams = Object.assign({}, params, {
      paginate: false,
      query
    });

    if (id !== null) {
      query.$and = (query.$and || []).concat({ [this.id]: id });
    }

    // NOTE (EK): First fetch the record(s) so that we can return
    // it/them when we delete it/them.
    return this.$getOrFind(id, findParams).then((data) => {
      if (id !== null) {
        return this.Model.deleteOne(query, params.mongoose)
          .lean(this.lean)
          .exec()
          .then(() => data)
          .then(select(params, this.id));
      }

      return this.Model.deleteMany(query, params.mongoose)
        .lean(this.lean)
        .exec()
        .then(() => data)
        .then(select(params, this.id));
    }).catch(errorHandler);
  }

  async find (params) { return this._find(params); }
  async get (id, params) { return this._get(id, params); }
  async create (data, params) { return this._create(data, params); }
  async update (id, data, params) { return this._update(id, data, params); }
  async patch (id, data, params) { return this._patch(id, data, params); }
  async remove (id, params) { return this._remove(id, params); }
}

function init (options) {
  return new Service(options);
}

module.exports = Object.assign(init, {
  default: init,
  ERROR,
  Service
});
