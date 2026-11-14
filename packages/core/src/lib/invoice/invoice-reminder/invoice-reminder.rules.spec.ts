import {
	amountLeftToPay,
	earliestRemindedDueDate,
	INVOICE_REMINDER_GRACE_MS,
	invoiceReminderDueAt,
	latestRemindedDueDate
} from './invoice-reminder.rules';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** An invoice due on 20 November, saved as the picker's local midnight (UTC+1 here). */
const DUE = new Date('2026-11-19T23:00:00.000Z');
/** Emailed to the client on 1 November. */
const EMAILED = new Date('2026-11-01T09:00:00.000Z');

const at = (offsetMs: number) => new Date(DUE.getTime() + offsetMs);

describe('invoiceReminderDueAt', () => {
	it('is due nothing before three days ahead of the due date', () => {
		expect(invoiceReminderDueAt(DUE, EMAILED, at(-3 * DAY - HOUR))).toBeNull();
	});

	it.each([
		['three days before the due date', -3 * DAY, 1, false],
		['once the due day is over', DAY, 2, true],
		['seven days after it', 7 * DAY, 3, true],
		['fourteen days after it', 14 * DAY, 4, true]
	])('is due its reminder %s, and still an hour later', (_, offset, step, isOverdue) => {
		for (const now of [at(offset), at(offset + HOUR)]) {
			expect(invoiceReminderDueAt(DUE, EMAILED, now)).toEqual({ step, at: DUE.getTime() + offset, isOverdue });
		}
	});

	it('is due no overdue reminder on the due day itself: the client still has the day to pay', () => {
		expect(invoiceReminderDueAt(DUE, EMAILED, at(12 * HOUR))).toBeNull();
		expect(invoiceReminderDueAt(DUE, EMAILED, at(DAY - 1))).toBeNull();
	});

	it('skips a reminder whose moment passed more than the grace ago, and nothing comes after the last one', () => {
		expect(invoiceReminderDueAt(DUE, EMAILED, at(DAY + INVOICE_REMINDER_GRACE_MS))).not.toBeNull();
		expect(invoiceReminderDueAt(DUE, EMAILED, at(DAY + INVOICE_REMINDER_GRACE_MS + 1))).toBeNull();
		expect(invoiceReminderDueAt(DUE, EMAILED, at(14 * DAY + INVOICE_REMINDER_GRACE_MS + 1))).toBeNull();
		expect(invoiceReminderDueAt(DUE, EMAILED, at(60 * DAY))).toBeNull();
	});

	it('is due only the latest step, never two at once', () => {
		// The reminders were turned on nine days after the due date: the second step's moment is long past
		expect(invoiceReminderDueAt(DUE, EMAILED, at(9 * DAY))).toEqual(expect.objectContaining({ step: 3 }));
	});

	it('sends no reminder on the heels of the invoice: a step its email came less than a day before is skipped', () => {
		// Emailed two days before the due date: the reminder three days before it is skipped, the day after it goes
		const late = at(-2 * DAY);
		expect(invoiceReminderDueAt(DUE, late, at(-2 * DAY + HOUR))).toBeNull();
		expect(invoiceReminderDueAt(DUE, late, at(DAY))).toEqual(expect.objectContaining({ step: 2 }));
		// Emailed half a day before the due day was over: that step is skipped too, the next one goes
		const later = at(DAY - 12 * HOUR);
		expect(invoiceReminderDueAt(DUE, later, at(DAY))).toBeNull();
		expect(invoiceReminderDueAt(DUE, later, at(7 * DAY))).toEqual(expect.objectContaining({ step: 3 }));
	});

	it('reads the dates a driver hands back as text, a raw SQLite read as UTC without its zone', () => {
		expect(invoiceReminderDueAt(DUE.toISOString(), EMAILED.toISOString(), at(DAY))).toEqual(
			expect.objectContaining({ step: 2, at: DUE.getTime() + DAY })
		);
		expect(invoiceReminderDueAt('2026-11-19 23:00:00.000', '2026-11-01 09:00:00.000', at(DAY))).toEqual(
			expect.objectContaining({ step: 2, at: DUE.getTime() + DAY })
		);
	});

	it('is due nothing for a date it cannot read', () => {
		expect(invoiceReminderDueAt('not a date', EMAILED, at(DAY))).toBeNull();
	});
});

describe('the due dates a sweep reads', () => {
	it('cover every invoice that may be due a reminder, and no other', () => {
		const now = new Date('2026-12-01T10:00:00.000Z');
		const earliest = earliestRemindedDueDate(now);
		const latest = latestRemindedDueDate(now);

		expect(invoiceReminderDueAt(earliest, EMAILED, now)).toEqual(expect.objectContaining({ step: 4 }));
		expect(invoiceReminderDueAt(new Date(earliest.getTime() - 1), EMAILED, now)).toBeNull();
		expect(invoiceReminderDueAt(latest, EMAILED, now)).toEqual(expect.objectContaining({ step: 1 }));
		expect(invoiceReminderDueAt(new Date(latest.getTime() + 1), EMAILED, now)).toBeNull();
	});
});

describe('amountLeftToPay', () => {
	it.each([
		[1250, 0, 1250],
		['1250.00', '250.5', 999.5],
		[100.1, null, 100.1],
		[0.3, 0.1, 0.2]
	])('leaves %p less %p: %p', (total, paid, left) => {
		expect(amountLeftToPay(total, paid)).toBe(left);
	});

	it.each([
		[100, 100],
		[100, 120],
		[null, 0],
		[undefined, 0],
		['abc', 0]
	])('leaves nothing to pay of %p after %p', (total, paid) => {
		expect(amountLeftToPay(total as never, paid)).toBeNull();
	});
});
