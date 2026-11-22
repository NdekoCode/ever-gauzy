import { ITimesheet, TimesheetStatus } from '@gauzy/contracts';
import { TimesheetFirstOrCreateOptions } from './commands/timesheet-first-or-create.command';

/** The statuses of a timesheet someone reviewed: an approval or a denial covers the time it held then. */
const REVIEWED_STATUSES: readonly string[] = [TimesheetStatus.APPROVED, TimesheetStatus.DENIED];

/**
 * Whether someone approved or denied the timesheet.
 *
 * @param timesheet - The timesheet, with its status.
 */
export function isReviewedTimesheet(timesheet: Pick<ITimesheet, 'status'>): boolean {
	return REVIEWED_STATUSES.includes(timesheet.status);
}

/**
 * The timesheet time of a week goes to, among the employee's timesheets of that week, oldest first, or none when a
 * new one is needed.
 *
 * Time already in one of the week's timesheets stays there. Otherwise a timesheet nobody reviewed yet comes first.
 * New time never goes to a reviewed timesheet: it waits for review in a timesheet of its own, and the reviewed one keeps
 * the time its review covered. Any other time goes to the reviewed timesheet when the week has no other, as before.
 *
 * @param timesheets - The employee's timesheets of the week, oldest first.
 * @param options - Whether the time is new, and the timesheet it is in already.
 */
export function timesheetOfWeek<T extends Pick<ITimesheet, 'id' | 'status'>>(
	timesheets: readonly T[],
	options: TimesheetFirstOrCreateOptions
): T | undefined {
	const current = timesheets.find((timesheet) => timesheet.id === options.currentTimesheetId);
	if (current) {
		return current;
	}
	const notReviewed = timesheets.find((timesheet) => !isReviewedTimesheet(timesheet));
	if (notReviewed) {
		return notReviewed;
	}
	if (options.forNewTime) {
		return undefined;
	}
	return timesheets[0];
}
