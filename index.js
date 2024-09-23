'use strict';

// Escape regular expression special characters
var _re_escape_regex = new RegExp( '(\\' + [ '/', '.', '*', '+', '?', '|', '(', ')', '[', ']', '{', '}', '\\', '$', '^', '-' ].join('|\\') + ')', 'g' );
    

const mongoose = require('mongoose');

/**
 * Method getSearchableFields
 * Returns an array of fieldNames based on DataTable params object
 * All columns in params.columns that have .searchable == true field will have the .data param returned in an String
 * array. The .data property is used because in angular frontend DTColumnBuilder.newColumn('str') puts 'str' in the
 * data field, instead of the name field.
 * @param params
 * @returns {Array}
 */
const getSearchableFields = (params) => {
    return params.columns.filter((column) => {
        return JSON.parse(column.searchable);
    }).map((column) => {
        return column.data;
    });
};

/**
 * Method isNaNorUndefined
 * Checks if any of the passed params is NaN or undefined.
 * @returns {boolean}
 */
const isNaNorUndefined = (...args) => {
    return args.some(arg => isNaN(arg) || (arg === undefined || arg === null));
};

/**
 * Escape a string for use in regular expressions
 * @param {string} val string to escape
 * @returns {string} escaped string
 */
const escapeRegex = (val) => {
    return val.replace(_re_escape_regex, '\\$1');
};


/**
 * Methdd buildFindParameters
 * Builds a MongoDB find expression based on DataTables param object
 * - If no search text if provided (in params.search.value) an empty object is returned, meaning all data in DB will
 * be returned.
 * - If only one column is searchable (that means, only one params.columns[i].searchable equals true) a normal one
 * field regex MongoDB query is returned, that is {`fieldName`: new Regex(params.search.value, 'i'}
 * - If multiple columns are searchable, an $or MongoDB is returned, that is:
 * ```
 * {
 *     $or: [
 *         {`searchableField1`: new Regex(params.search.value, 'i')},
 *         {`searchableField2`: new Regex(params.search.value, 'i')}
 *     ]
 * }
 * ```
 * and so on.<br>
 * All search are by regex so the field param.search.regex is ignored.
 * @param params DataTable params object
 * @returns {*}
 */
const buildFindParameters = (params) => {
    if (!params || !params.columns || !params.search || (!params.search.value && params.search.value !== '')) {
        return null;
    }

    const searchText = escapeRegex(params.search.value);
    const findParameters = (params.find) ? params.find : {};
    let searchRegex;
    const searchOrArray = [];

    if (searchText === '') {
        return findParameters;
    }

    if (params.search && params.search.smart) {
        const words = (searchText.match(/"[^"]+"|[^ ]+/g) || ['']).map((word) => {
            if (word.charAt(0) === '"') {
                const m = word.match(/^"(.*)"$/);
                word = m ? m[1] : word;
            }
            return word.replace('"', '');
        });

        searchRegex = new RegExp('^(?=.*?' + words.join(')(?=.*?') + ').*$', 'i');
    } else {
        searchRegex = new RegExp(searchText, 'i');
    }

    const searchableFields = getSearchableFields(params);

    if (searchableFields.length === 1) {
        findParameters[searchableFields[0]] = searchRegex;
        return findParameters;
    }

    searchableFields.forEach((field) => {
        const orCondition = {};
        orCondition[field] = searchRegex;
        searchOrArray.push(orCondition);
    });

    if (findParameters.$or) {
        const prevOr = findParameters.$or;
        delete findParameters.$or;
        findParameters.$and = [{ $or: searchOrArray }, { $or: prevOr }];
    } else {
        findParameters.$or = searchOrArray;
    }

    return findParameters;
};

/**
 * Method buildSortParameters
 * Based on DataTable parameters, this method returns a MongoDB ordering parameter for the appropriate field
 * The params object must contain the following properties:
 * order: Array containing a single object
 * order[0].column: A string parseable to an Integer, that references the column index of the reference field
 * order[0].dir: A string that can be either 'asc' for ascending order or 'desc' for descending order
 * columns: Array of column's description object
 * columns[i].data: The name of the field in MongoDB. If the index i is equal to order[0].column, and
 * the column is orderable, then this will be the returned search param
 * columns[i].orderable: A string (either 'true' or 'false') that denotes if the given column is orderable
 * @param params
 * @returns {*}
 */
const buildSortParameters = (params) => {
    if (!params || !Array.isArray(params.order) || params.order.length === 0) {
        return null;
    }

    const sortColumn = Number(params.order[0].column);
    const sortOrder = params.order[0].dir;
    if (isNaNorUndefined(sortColumn) || !Array.isArray(params.columns) || sortColumn >= params.columns.length) {
        return null;
    }

    if (params.columns[sortColumn].orderable === 'false') {
        return null;
    }

    const sortField = params.columns[sortColumn].data;
    if (!sortField) {
        return null;
    }

    const sortObj = {};
    sortObj[sortField] = sortOrder === 'asc' ? 1 : -1;
    return sortObj;
};

/**
 * Method buildSelectParameters
 * Returns MongoDB select parameters based on DataTable params
 * @param params
 * @returns {Object|null}
 */
const buildSelectParameters = (params) => {
    if (!params || !params.columns || !Array.isArray(params.columns)) {
        return null;
    }

    return params.columns.reduce((selectParams, column) => {
        selectParams[column.data] = 1;
        return selectParams;
    }, {});
};

/**
 * Run wrapper function
 * Serves only to the Model parameter in the wrapped run function's scope
 * @param {Object} Model Mongoose Model Object, target of the search
 * @returns {Function} the actual run function with Model in its scope
 */
const run = (Model) => {

    /**
     * Method Run
     * The actual run function
     * Performs the query on the passed Model object, using the DataTable params argument
     * @param {Object} params DataTable params object
     */
    return (params) => {

        const draw = Number(params.draw),
            start = Number(params.start),
            length = Number(params.length),
            findParameters = buildFindParameters(params),
            sortParameters = buildSortParameters(params),
            selectParameters = buildSelectParameters(params);
        let recordsTotal,
            recordsFiltered;

        return new Promise(function (fulfill, reject) {
            
            if (isNaNorUndefined(draw, start, length)) {
                return reject(
                    new Error(
                    'Some parameters are missing or in a wrong state. ' +
                        'Could be any of draw, start or length'
                    )
                );
            }

            if (!findParameters || !sortParameters || !selectParameters) {
                return reject(
                    new Error('Invalid findParameters or sortParameters or selectParameters')
                );
            }

            // Fetch recordsTotal
            Model.countDocuments(params.find || {})
            .then((count) => {
                recordsTotal = count;
                // Fetch recordsFiltered
                return Model.countDocuments(findParameters);
            })
            .then((count) => {
                recordsFiltered = count;
                // Build the query
                let query = Model.find(findParameters)
                    .select(selectParameters)
                    .limit(length)
                    .skip(start)
                    .sort(sortParameters);
        
                if (params.populate) {
                    query = query.populate(params.populate);
                }
        
                return query.exec();
                })
                .then((results) => {
                fulfill({
                    draw: draw,
                    recordsTotal: recordsTotal,
                    recordsFiltered: recordsFiltered,
                    data: results,
                });
                })
                .catch((err) => {
                    reject({ error: err });
                });
        });
    };
};

/**
 * Module datatablesQuery
 * Performs queries in the given Mongoose Model object, following DataTables conventions for search and
 * pagination.
 * The only interesting exported function is `run`. The others are exported only to allow unit testing.
 * @param Model
 * @returns {{run: Function, isNaNorUndefined: Function, buildFindParameters: Function, buildSortParameters:
 *     Function}}
 */
const datatablesQuery = (Model) => {
    return {
        run: run(Model),
        isNaNorUndefined: isNaNorUndefined,
        buildFindParameters: buildFindParameters,
        buildSortParameters: buildSortParameters,
        buildSelectParameters: buildSelectParameters,
        escapeRegex: escapeRegex, // Optional: export if needed for testing
        getSearchableFields: getSearchableFields, // Optional: export if needed for testing
    };
};

module.exports = datatablesQuery;
