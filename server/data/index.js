/**
 * One import point for the data layer.
 *
 * Callers say `require('../data')` and get every repository function, so a file
 * moving between repositories doesn't ripple out into services and tools.
 */

module.exports = {
    ...require('./companies'),
    ...require('./profiles'),
    ...require('./jobs'),
    ...require('./applications'),
    ...require('./notifications'),
    ...require('./users'),
    ...require('./tenancy'),
    ...require('../domain/locations'),
};
