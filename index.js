"use strict";
const joi = require("joi");
const { aql, db, query } = require("@arangodb");
const { context } = require("@arangodb/locals");
const createRouter = require("@arangodb/foxx/router");
const { getAuth } = require("./util");

/** @type {{
 *   collections: string,
 *   aggregation: string,
 *   dateField: string,
 *   valueField: string,
 *   username: string,
 *   password: string
 * }} */
const cfg = context.configuration;
const allowAggregations = [
  "AVERAGE",
  "AVG",
  "COUNT",
  "COUNT_DISTINCT",
  "COUNT_UNIQUE",
  "LENGTH",
  "MAX",
  "MIN",
  "SORTED_UNIQUE",
  "STDDEV",
  "STDDEV_POPULATION",
  "STDDEV_SAMPLE",
  "SUM",
  "UNIQUE",
  "VARIANCE",
  "VARIANCE_POPULATION",
  "VARIANCE_SAMPLE",
  "NONE"
];

const AGG_NAME = cfg.aggregation.toUpperCase();

if (!allowAggregations.includes(AGG_NAME)) {
  throw new Error(
    `Invalid service configuration. Unknown aggregation function: ${
    cfg.aggregation
    }, allowed are ${allowAggregations.join(", ")}`
  );
}

// set aggregation function
const AGG = AGG_NAME === "NONE" ? null : aql.literal(AGG_NAME);
const COLLECTIONS_EXPOSED = cfg.collections.split(",").map(str => str.trim());

// validate collections
for (const collection of COLLECTIONS_EXPOSED) {
  if (!db._collection(collection)) {
    throw new Error(
      `Invalid service configuration. Unknown collection: ${collection}`
    );
  }
}

const router = createRouter();
context.use(router);

// Test for authentication
router.use((req, res, next) => {
  const auth = getAuth(req);
  if (!auth || !auth.basic) {
    res.throw(401, "Authentication required");
  }
  const { username, password } = auth.basic;
  if (
    username !== cfg.username ||
    (cfg.password && password !== cfg.password)
  ) {
    res.throw(403, "Bad username or password");
  }
  next();
});


router
  .get("/", (_req, res) => {
    res.json({ ok: true });
  })
  .summary("SimpleJSON self-test endpoint")
  .description(
    "This is a dummy endpoint used by the SimpleJSON data source to confirm that the data source is configured correctly."
  );

router
  .post("/search", (_req, res) => {
    res.json(COLLECTIONS_EXPOSED);
  })
  .summary("List the available metrics")
  .description(
    "This endpoint is used to determine which metrics (collections) are available to the data source."
  );

const getSeries = (collection, start, end, interval) => {
  const {
    dateField,
    dateExpression,
    filterExpression,
    valueField,
    valueExpression
  } = cfg;

  if (AGG) {
    return query`
      FOR doc IN ${collection}
      LET d = ${dateExpression ? aql.literal(dateExpression) : aql`doc[${dateField}]`}
      FILTER d >= ${start} AND d < ${end}
      ${filterExpression ? aql`FILTER ${aql.literal(filterExpression)}` : aql``}
      LET v = ${valueExpression ? aql.literal(valueExpression) : aql`doc[${valueField}]`}
      COLLECT date = FLOOR(d / ${interval}) * ${interval}
      AGGREGATE value = ${AGG}(v)
      RETURN [value, date]
    `.toArray();
  } else {
    return query`
      FOR doc IN ${collection}
      LET d = ${dateExpression ? aql.literal(dateExpression) : aql`doc[${dateField}]`}
      FILTER d >= ${start} AND d < ${end}
      ${filterExpression ? aql`FILTER ${aql.literal(filterExpression)}` : aql``}
      LET v = ${valueExpression ? aql.literal(valueExpression) : aql`doc[${valueField}]`}
      RETURN [v, d]
    `.toArray();
  }
};

router
  .post("/query", (req, res) => {
    const body = req.body;
    const interval = body.intervalMs;
    const start = Number(new Date(body.range.from));
    const end = Number(new Date(body.range.to));
    const response = [];
    for (const { target, type } of body.targets) {
      const collection = db._collection(target);
      const datapoints = getSeries(collection, start, end, interval);
      if (type === "table") {
        response.push({
          target,
          type: "table",
          columns: [{ text: "date" }, { text: "value" }],
          rows: datapoints.map(([a, b]) => [b, a])
        });
      } else {
        response.push({
          target,
          type: "timeseries",
          datapoints
        });
      }
    }
    res.json(response);
  })
  .body(
    joi
      .object({
        intervalMs: joi.number().required(),
        range: joi
          .object({
            from: joi.string().required(),
            to: joi.string().required(),
            raw: joi.any().optional()
          })
          .required(),
        targets: joi
          .array()
          .items(
            joi
              .object({
                target: joi.allow(...TARGETS).required(),
                type: joi.allow("timeseries", "table").required()
              })
              .required()
          )
          .required()
      })
      .options({ allowUnknown: true })
  )
  .summary("Perform a SimpleJSON query")
  .description(
    "This endpoint performs the actual query for one or more metrics in a given time range. Results are aggregated with the given interval."
  );
