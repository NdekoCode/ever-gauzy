import { TimesheetStatus } from '@gauzy/contracts';
import { isReviewedTimesheet, timesheetOfWeek } from './timesheet-of-week';

const timesheet = (id: string, status: TimesheetStatus) => ({ id, status });

describe('isReviewedTimesheet', () => {
	it('reads an approved or a denied timesheet as reviewed', () => {
		expect(isReviewedTimesheet(timesheet('a', TimesheetStatus.APPROVED))).toBe(true);
		expect(isReviewedTimesheet(timesheet('d', TimesheetStatus.DENIED))).toBe(true);
	});

	it('reads a draft, pending or in-review timesheet as not reviewed', () => {
		expect(isReviewedTimesheet(timesheet('1', TimesheetStatus.DRAFT))).toBe(false);
		expect(isReviewedTimesheet(timesheet('2', TimesheetStatus.PENDING))).toBe(false);
		expect(isReviewedTimesheet(timesheet('3', TimesheetStatus.IN_REVIEW))).toBe(false);
	});
});

describe('timesheetOfWeek', () => {
	const approved = timesheet('approved', TimesheetStatus.APPROVED);
	const denied = timesheet('denied', TimesheetStatus.DENIED);
	const pending = timesheet('pending', TimesheetStatus.PENDING);
	const inReview = timesheet('in-review', TimesheetStatus.IN_REVIEW);

	describe.each([{ forNewTime: true }, {}])('options %j', (options) => {
		it('gives the week its only timesheet when nobody reviewed it', () => {
			expect(timesheetOfWeek([pending], options)).toBe(pending);
			expect(timesheetOfWeek([inReview], options)).toBe(inReview);
		});

		it('gives the timesheet nobody reviewed before a reviewed one, wherever it is in the week', () => {
			expect(timesheetOfWeek([approved, pending], options)).toBe(pending);
			expect(timesheetOfWeek([denied, approved, inReview], options)).toBe(inReview);
		});

		it('gives the oldest of the timesheets nobody reviewed', () => {
			const later = timesheet('later', TimesheetStatus.PENDING);
			expect(timesheetOfWeek([approved, pending, later], options)).toBe(pending);
		});

		it('gives none for a week without a timesheet', () => {
			expect(timesheetOfWeek([], options)).toBeUndefined();
		});
	});

	it('gives new time no timesheet in a week that only holds an approved or a denied one', () => {
		expect(timesheetOfWeek([approved], { forNewTime: true })).toBeUndefined();
		expect(timesheetOfWeek([denied], { forNewTime: true })).toBeUndefined();
		expect(timesheetOfWeek([approved, denied], { forNewTime: true })).toBeUndefined();
	});

	it('gives any other time the reviewed timesheet when the week has no other, as before', () => {
		expect(timesheetOfWeek([approved], {})).toBe(approved);
		expect(timesheetOfWeek([denied, approved], {})).toBe(denied);
	});

	it('keeps time in the timesheet it is in while that timesheet is one of the week, reviewed or not', () => {
		expect(timesheetOfWeek([approved, pending], { currentTimesheetId: 'approved' })).toBe(approved);
		expect(timesheetOfWeek([approved, pending], { currentTimesheetId: 'pending' })).toBe(pending);
	});

	it('looks for another timesheet when the one the time is in is not of the week', () => {
		expect(timesheetOfWeek([approved, pending], { currentTimesheetId: 'of-another-week' })).toBe(pending);
		expect(timesheetOfWeek([approved], { currentTimesheetId: 'of-another-week' })).toBe(approved);
	});
});
