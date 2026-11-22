// Must stay first: loads the entity graph before any handler pulls an entity (see activity.controller.spec.ts).
import '../../../../core/entities/internal';

import { knex as createKnex, Knex } from 'knex';
import { RequestContext } from '../../../../core/context';
import { MultiORMEnum } from '../../../../core/utils';
import { TimesheetCreateCommand } from '../timesheet-create.command';
import { TimesheetFirstOrCreateCommand } from '../timesheet-first-or-create.command';
import { TimesheetFirstOrCreateHandler } from './timesheet-first-or-create.handler';

/**
 * On MikroORM the week's timesheet is looked up with raw knex, which applies no soft-delete filter: a deleted
 * timesheet of the week was handed back and new time logs were attached to it. Run against an in-memory SQLite
 * store through knex, as the handler queries it.
 */
const TENANT_ID = 'tenant-1';
const ORGANIZATION_ID = 'org-1';
const EMPLOYEE_ID = 'employee-1';
const DATE = new Date('2026-10-21T10:00:00Z');
const WEEK_START = new Date('2026-10-18T00:00:00Z');
const WEEK_END = new Date('2026-10-24T23:59:59Z');

describe('TimesheetFirstOrCreateHandler soft-deleted timesheet (MikroORM)', () => {
	let db: Knex;
	let commandBus: { execute: jest.Mock };
	let handler: TimesheetFirstOrCreateHandler;

	const insertTimesheet = (id: string, deletedAt: Date | null, columns: { status?: string; createdAt?: Date } = {}) =>
		db('timesheet').insert({
			id,
			tenantId: TENANT_ID,
			organizationId: ORGANIZATION_ID,
			employeeId: EMPLOYEE_ID,
			startedAt: WEEK_START,
			stoppedAt: WEEK_END,
			deletedAt,
			...columns
		});

	beforeEach(async () => {
		// The handler reads `knex.userParams.schema`, as the MikroORM knex carries it; SQLite's own schema is `main`
		db = createKnex({
			client: 'better-sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			// `userParams` is read by knex at runtime but missing from its `Config` type (only `TransactionConfig` has it)
			userParams: { schema: 'main' }
		} as Knex.Config);
		await db.schema.createTable('timesheet', (table) => {
			table.string('id').primary();
			table.string('tenantId');
			table.string('organizationId');
			table.string('employeeId');
			table.datetime('startedAt');
			table.datetime('stoppedAt');
			table.datetime('deletedAt').nullable();
			table.string('status').defaultTo('PENDING');
			table.datetime('createdAt').defaultTo(db.fn.now());
		});

		jest.spyOn(RequestContext, 'currentTenantId').mockReturnValue(TENANT_ID);
		commandBus = { execute: jest.fn().mockResolvedValue({ id: 'created' }) };
		handler = new TimesheetFirstOrCreateHandler(
			{} as never,
			{ getKnex: () => db } as never,
			{} as never,
			commandBus as never
		);
		Object.defineProperty(handler, 'ormType', { value: MultiORMEnum.MikroORM });
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		await db.destroy();
	});

	const run = () => handler.execute(new TimesheetFirstOrCreateCommand(DATE, EMPLOYEE_ID, ORGANIZATION_ID));

	it('does not reuse a soft-deleted timesheet of the week and creates a new one', async () => {
		await insertTimesheet('deleted', new Date('2026-10-20T00:00:00Z'));

		const result = await run();

		expect(result).toEqual({ id: 'created' });
		expect(commandBus.execute).toHaveBeenCalledTimes(1);
		expect(commandBus.execute.mock.calls[0][0]).toBeInstanceOf(TimesheetCreateCommand);
	});

	it('picks the live timesheet over a soft-deleted one of the same week', async () => {
		await insertTimesheet('deleted', new Date('2026-10-20T00:00:00Z'));
		await insertTimesheet('live', null);

		const result = await run();

		expect(result).toMatchObject({ id: 'live' });
		expect(commandBus.execute).not.toHaveBeenCalled();
	});

	describe('a week someone reviewed', () => {
		const EARLIER = new Date('2026-10-19T08:00:00Z');
		const LATER = new Date('2026-10-20T08:00:00Z');
		const runForNewTime = () =>
			handler.execute(
				new TimesheetFirstOrCreateCommand(DATE, EMPLOYEE_ID, ORGANIZATION_ID, { forNewTime: true })
			);

		it.each(['APPROVED', 'DENIED'])(
			'gives new time a new timesheet when the week only holds a %s one',
			async (status) => {
				await insertTimesheet('reviewed', null, { status, createdAt: EARLIER });

				const result = await runForNewTime();

				expect(result).toEqual({ id: 'created' });
				expect(commandBus.execute.mock.calls[0][0]).toBeInstanceOf(TimesheetCreateCommand);
			}
		);

		it('gives new time the timesheet of the week nobody reviewed yet, created after the approved one', async () => {
			await insertTimesheet('approved', null, { status: 'APPROVED', createdAt: EARLIER });
			await insertTimesheet('pending', null, { status: 'PENDING', createdAt: LATER });

			const result = await runForNewTime();

			expect(result).toMatchObject({ id: 'pending' });
			expect(commandBus.execute).not.toHaveBeenCalled();
		});

		it('keeps the approved timesheet for any other change when the week has no other, as before', async () => {
			await insertTimesheet('approved', null, { status: 'APPROVED', createdAt: EARLIER });

			const result = await run();

			expect(result).toMatchObject({ id: 'approved' });
			expect(commandBus.execute).not.toHaveBeenCalled();
		});

		it('gives any other change the timesheet nobody reviewed yet when the week holds both', async () => {
			await insertTimesheet('approved', null, { status: 'APPROVED', createdAt: EARLIER });
			await insertTimesheet('pending', null, { status: 'PENDING', createdAt: LATER });

			const result = await run();

			expect(result).toMatchObject({ id: 'pending' });
		});

		it('keeps time in the timesheet of the week it is in, the approved one included', async () => {
			await insertTimesheet('approved', null, { status: 'APPROVED', createdAt: EARLIER });
			await insertTimesheet('pending', null, { status: 'PENDING', createdAt: LATER });

			const result = await handler.execute(
				new TimesheetFirstOrCreateCommand(DATE, EMPLOYEE_ID, ORGANIZATION_ID, {
					currentTimesheetId: 'approved'
				})
			);

			expect(result).toMatchObject({ id: 'approved' });
			expect(commandBus.execute).not.toHaveBeenCalled();
		});
	});
});
