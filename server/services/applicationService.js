/**
 * Rules for changing an application, kept away from both HTTP and SQL.
 *
 * The web layer's job is to turn a request into arguments; the data layer's job
 * is to run the statement. Deciding what a valid change looks like is neither,
 * and it is the part you'd want to reuse if a CLI or a scheduled job ever
 * updated an application too.
 */

const data = require('../data');
const { APPLICATION_STATUSES, isApplicationStatus } = require('../domain/applicationStatus');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and apply a partial update.
 *
 * The three-way distinction matters and is easy to lose:
 *   key absent    -> leave that field alone
 *   key present, empty -> clear it (status '' removes the application entirely)
 *   key present, set   -> use it
 *
 * @returns {{ok: true, application: object|null} | {ok: false, error: string}}
 */
function updateApplication(userId, payload = {}) {
    const jobId = Number(payload.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
        return { ok: false, error: 'jobId must be a positive integer' };
    }

    const status = 'status' in payload ? payload.status || null : undefined;
    if (status && !isApplicationStatus(status)) {
        return { ok: false, error: `status must be one of: ${APPLICATION_STATUSES.join(', ')}` };
    }

    const appliedAt = 'appliedAt' in payload ? payload.appliedAt || null : undefined;
    if (appliedAt && !DATE_RE.test(appliedAt)) {
        return { ok: false, error: 'appliedAt must be YYYY-MM-DD' };
    }

    try {
        const application = data.setApplication({
            userId,
            jobSnapshotId: jobId,
            status,
            appliedAt,
            notes: 'notes' in payload ? payload.notes : undefined,
        });
        return { ok: true, application };
    } catch (err) {
        // Most likely a jobId that doesn't exist — the foreign key rejects it.
        return { ok: false, error: err.message };
    }
}

/** The dashboard's view: every tracked application plus a count per status. */
function listApplications(userId) {
    const applications = data.listApplications(userId);
    const counts = {};
    for (const application of applications) {
        counts[application.status] = (counts[application.status] || 0) + 1;
    }
    return { applications, counts, statusVocabulary: APPLICATION_STATUSES };
}

module.exports = { updateApplication, listApplications };
