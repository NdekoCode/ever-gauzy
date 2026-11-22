import { ICommand } from '@nestjs/cqrs';
import { ID } from '@gauzy/contracts';

/** How the timesheet of the week is chosen. */
export interface TimesheetFirstOrCreateOptions {
	/**
	 * The time is new: it never goes to a timesheet that was approved or denied, which keeps the time its review
	 * covered, but to a timesheet of the week nobody reviewed yet, or a new one.
	 */
	readonly forNewTime?: boolean;
	/** The timesheet the time is in already: it stays there while that timesheet is one of the week's. */
	readonly currentTimesheetId?: ID;
}

export class TimesheetFirstOrCreateCommand implements ICommand {
	static readonly type = '[Timesheet] First Or Create';

	constructor(
		public readonly date: Date,
		public readonly employeeId: ID,
		public readonly organizationId?: ID,
		public readonly options: TimesheetFirstOrCreateOptions = {}
	) { }
}
