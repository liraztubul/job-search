/**
 * The application pipeline vocabulary.
 *
 * Lives in the domain, not in the web layer, because three places have to agree
 * on it: the API validates against it, the database stores it, and the UI builds
 * its dropdown from it. One list, imported.
 *
 * Order matters — it is the order the dashboard shows the summary in.
 */

const APPLICATION_STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'rejected'];

const isApplicationStatus = (value) => APPLICATION_STATUSES.includes(value);

module.exports = { APPLICATION_STATUSES, isApplicationStatus };
