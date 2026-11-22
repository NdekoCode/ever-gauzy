import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DataSource } from 'typeorm';
import { insertRow } from '../../../../database/testing/insert-row';

// The tenant check on project / task / client / team has its own spec (time-log-references.spec.ts).
jest.mock('../../time-log-references', () => ({ assertTimeLogReferencesOfTenant: jest.fn(async () => undefined) }));

/**
 * Time added to a week whose timesheet was approved or denied waits for review: it goes to a timesheet of the week
 * nobody reviewed yet, or a new pending one, and the reviewed timesheet keeps the time its review covered. Before, every
 * new time log joined the week's timesheet whatever its status, so an entry added by hand, or a timer run, in an
 * approved week counted as approved at once, and in a denied week as denied, with the old reason.
 *
 * The real create handler writes each entry on one SQLite database, and the real week lookup reads the timesheets
 * through TypeORM and through MikroORM (its knex read). The entities are imported under `DB_ORM=mikro-orm` in a registry
 * kept open while both ORMs build their metadata (see `time-log.service.reports.dual-orm.spec.ts`); everything is
 * measured in `beforeAll` and asserted below.
 */

const TIMEOUT = 15 * 60 * 1000;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION = '22222222-2222-4222-8222-222222222222';
const ORMS = ['typeOrm', 'mikroOrm'] as const;
type Orm = (typeof ORMS)[number];

/** One employee per ORM, so that each ORM's entries meet only the timesheets seeded for it. */
const PEOPLE: Record<Orm, { user: string; employee: string }> = {
	typeOrm: { user: '33333333-3333-4333-8333-333333333331', employee: '44444444-4444-4444-8444-444444444441' },
	mikroOrm: { user: '33333333-3333-4333-8333-333333333332', employee: '44444444-4444-4444-8444-444444444442' }
};

/** The weeks of the scenario (Sunday to Saturday, UTC) and the timesheets each holds before any entry is added. */
const WEEKS = {
	approved: { from: '2026-11-01', to: '2026-11-07', statuses: ['APPROVED'] },
	denied: { from: '2026-11-08', to: '2026-11-14', statuses: ['DENIED'] },
	pending: { from: '2026-11-15', to: '2026-11-21', statuses: ['PENDING'] },
	approvedThenPending: { from: '2026-11-22', to: '2026-11-28', statuses: ['APPROVED', 'PENDING'] },
	approvedForTimer: { from: '2026-11-29', to: '2026-12-05', statuses: ['APPROVED'] }
} as const;
type Week = keyof typeof WEEKS;

/** The timesheet an entry went to, and what the week's timesheets are once it is written. */
type Outcome = {
	joined: 'existing reviewed' | 'existing not reviewed' | 'new';
	status: string;
	timesheetsOfWeek: string[];
	reviewedTimesheetLogs: number;
};

type Measured = Record<
	Orm,
	Record<'byHandApproved' | 'byHandDenied' | 'byHandPending' | 'byHandApprovedThenPending' | 'timerApproved', Outcome>
>;

const timesheetId = (orm: Orm, week: Week, index: number) => {
	const ormDigit = ORMS.indexOf(orm) + 1;
	const weekDigit = Object.keys(WEEKS).indexOf(week) + 1;
	return `55555555-5555-4555-8555-5555555${ormDigit}${weekDigit}${index}00`;
};

async function measure(): Promise<Measured> {
	const previous = { DB_ORM: process.env.DB_ORM, DB_TYPE: process.env.DB_TYPE };
	process.env.DB_ORM = 'mikro-orm';
	// Whatever database the machine's environment names: both ORMs read the one SQLite file below
	process.env.DB_TYPE = 'better-sqlite3';
	const file = path.join(os.tmpdir(), `gauzy-reviewed-week-${process.pid}-${Date.now()}.sqlite3`);
	const measured = { typeOrm: {}, mikroOrm: {} } as Measured;
	let dataSource: DataSource | undefined;

	try {
		await jest.isolateModulesAsync(async () => {
			const { coreEntities } = require('../../../../core/entities');
			const { dbMikroOrmConnectionConfig } = require('@gauzy/config');
			const { DataSource: TypeOrmDataSource } = require('typeorm');
			const { MikroORM } = require('@mikro-orm/core');
			const { MultiORMEnum } = require('../../../../core/utils');
			const { RequestContext } = require('../../../../core/context');
			const { TimeLogSourceEnum, TimeLogType } = require('@gauzy/contracts');
			const { TimeLog } = require('../../time-log.entity');
			const { Timesheet } = require('../../../timesheet/timesheet.entity');
			const { TimesheetCreateCommand, TimesheetFirstOrCreateCommand } = require('../../../timesheet/commands');
			const {
				TimesheetFirstOrCreateHandler
			} = require('../../../timesheet/commands/handlers/timesheet-first-or-create.handler');
			const {
				MikroOrmTimesheetRepository
			} = require('../../../timesheet/repository/mikro-orm-timesheet.repository');
			const { TimeLogCreateCommand } = require('../time-log-create.command');
			const { TimeLogCreateHandler } = require('./time-log-create.handler');

			// The tables TypeORM creates, as the migrations create them for the running platform.
			const database: DataSource = new TypeOrmDataSource({
				type: 'better-sqlite3',
				database: file,
				entities: coreEntities,
				synchronize: true
			});
			dataSource = database;
			await database.initialize();
			// The custom-fields placeholder column the migrations add, which synchronize leaves out.
			await database.query(`ALTER TABLE "employee" ADD COLUMN "fix_relational_custom_fields" boolean`);

			const scope = { tenantId: TENANT, organizationId: ORGANIZATION };
			await insertRow(database, 'Tenant', { id: TENANT, name: 'Tenant' });
			await insertRow(database, 'Organization', { id: ORGANIZATION, tenantId: TENANT, name: 'Organization' });
			for (const orm of ORMS) {
				const person = PEOPLE[orm];
				await insertRow(database, 'User', {
					id: person.user,
					tenantId: TENANT,
					firstName: 'Lea',
					lastName: orm
				});
				await insertRow(database, 'Employee', { ...scope, id: person.employee, userId: person.user });
				for (const [week, { from, to, statuses }] of Object.entries(WEEKS) as Array<
					[Week, (typeof WEEKS)[Week]]
				>) {
					for (const [index, status] of statuses.entries()) {
						await insertRow(database, 'Timesheet', {
							...scope,
							id: timesheetId(orm, week, index),
							employeeId: person.employee,
							startedAt: new Date(`${from}T00:00:00.000Z`),
							stoppedAt: new Date(`${to}T23:59:59.999Z`),
							status,
							// Seeded before any entry of the scenario, the later timesheet of a week a day later
							createdAt: new Date(`2026-10-0${index + 1}T12:00:00.000Z`)
						});
					}
				}
			}

			const mikroOrm = await MikroORM.init({
				...dbMikroOrmConnectionConfig,
				dbName: file,
				entities: coreEntities,
				allowGlobalContext: true,
				colors: false,
				discovery: { warnWhenNoEntities: false }
			});

			const timesheets = database.getRepository(Timesheet);
			const timeLogs = database.getRepository(TimeLog);

			// The commands the create handler sends: the week lookup and its creation for real, the rest answered.
			const commandBusOf = (orm: Orm) => {
				const bus = {
					execute: async (command: unknown): Promise<unknown> => {
						if (command instanceof TimesheetFirstOrCreateCommand) {
							const lookup = new TimesheetFirstOrCreateHandler(
								timesheets,
								new MikroOrmTimesheetRepository(mikroOrm.em.fork(), Timesheet),
								{} as never,
								bus as never
							);
							const ormType = orm === 'typeOrm' ? MultiORMEnum.TypeORM : MultiORMEnum.MikroORM;
							Object.defineProperty(lookup, 'ormType', { value: ormType });
							return lookup.execute(command);
						}
						if (command instanceof TimesheetCreateCommand) {
							const { input } = command as { input: Record<string, unknown> };
							return timesheets.save(timesheets.create({ ...input, tenantId: TENANT }));
						}
						return undefined;
					}
				};
				return bus;
			};

			jest.spyOn(RequestContext, 'currentTenantId').mockReturnValue(TENANT);

			const add = async (orm: Orm, week: Week, startedAt: string, stoppedAt?: string): Promise<Outcome> => {
				const handler = new TimeLogCreateHandler(
					timeLogs,
					{} as never,
					commandBusOf(orm) as never,
					// The entry's slots have their own specs: none is written here
					{ generateTimeSlots: () => [], bulkCreate: async () => [] } as never,
					{ findOneByIdString: (id: string) => timeLogs.findOneBy({ id }) } as never
				);
				const isTimer = stoppedAt === undefined;
				const created = await handler.execute(
					new TimeLogCreateCommand({
						...scope,
						employeeId: PEOPLE[orm].employee,
						startedAt: new Date(startedAt),
						...(isTimer ? {} : { stoppedAt: new Date(stoppedAt) }),
						logType: isTimer ? TimeLogType.TRACKED : TimeLogType.MANUAL,
						source: TimeLogSourceEnum.TEAMS,
						isRunning: isTimer
					})
				);
				const seeded = WEEKS[week].statuses.map((_, index) => timesheetId(orm, week, index));
				const reviewed = seeded.filter((_, index) => WEEKS[week].statuses[index] !== 'PENDING');
				const joinedTimesheet = await timesheets.findOneBy({ id: created.timesheetId });
				const weekTimesheets = await timesheets.find({
					where: { employeeId: PEOPLE[orm].employee },
					order: { createdAt: 'ASC' }
				});
				const inWeek = weekTimesheets.filter(
					(timesheet) => new Date(timesheet.startedAt).toISOString().slice(0, 10) === WEEKS[week].from
				);
				let joined: Outcome['joined'] = 'new';
				if (reviewed.includes(created.timesheetId)) {
					joined = 'existing reviewed';
				} else if (seeded.includes(created.timesheetId)) {
					joined = 'existing not reviewed';
				}
				return {
					joined,
					status: joinedTimesheet?.status,
					timesheetsOfWeek: inWeek.map((timesheet) => timesheet.status),
					reviewedTimesheetLogs: reviewed.length
						? await timeLogs.countBy(reviewed.map((id) => ({ timesheetId: id })))
						: 0
				};
			};

			try {
				for (const orm of ORMS) {
					measured[orm].byHandApproved = await add(
						orm,
						'approved',
						'2026-11-02T09:00:00.000Z',
						'2026-11-02T10:30:00.000Z'
					);
					measured[orm].byHandDenied = await add(
						orm,
						'denied',
						'2026-11-09T09:00:00.000Z',
						'2026-11-09T10:30:00.000Z'
					);
					measured[orm].byHandPending = await add(
						orm,
						'pending',
						'2026-11-16T09:00:00.000Z',
						'2026-11-16T10:30:00.000Z'
					);
					measured[orm].byHandApprovedThenPending = await add(
						orm,
						'approvedThenPending',
						'2026-11-23T09:00:00.000Z',
						'2026-11-23T10:30:00.000Z'
					);
					measured[orm].timerApproved = await add(orm, 'approvedForTimer', '2026-11-30T09:00:00.000Z');
				}
			} finally {
				await mikroOrm.close(true);
			}
		});
	} finally {
		jest.restoreAllMocks();
		// Here rather than after the reads, so a read that throws cannot leave the database file open
		if (dataSource?.isInitialized) await dataSource.destroy();
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(file, { force: true });
	}

	return measured;
}

describe('TimeLogCreateHandler: time added to a reviewed week waits for review, on one database through both ORMs', () => {
	let measured: Measured;

	beforeAll(async () => {
		measured = await measure();
	}, TIMEOUT);

	describe.each(ORMS)('%s', (orm) => {
		it('puts an entry added by hand to an approved week in a new pending timesheet, and leaves the approved one as it was', () => {
			expect(measured[orm].byHandApproved).toEqual({
				joined: 'new',
				status: 'PENDING',
				timesheetsOfWeek: ['APPROVED', 'PENDING'],
				reviewedTimesheetLogs: 0
			});
		});

		it('puts an entry added by hand to a denied week in a new pending timesheet, and leaves the denied one as it was', () => {
			expect(measured[orm].byHandDenied).toEqual({
				joined: 'new',
				status: 'PENDING',
				timesheetsOfWeek: ['DENIED', 'PENDING'],
				reviewedTimesheetLogs: 0
			});
		});

		it('puts a timer run started in an approved week in a new pending timesheet', () => {
			expect(measured[orm].timerApproved).toEqual({
				joined: 'new',
				status: 'PENDING',
				timesheetsOfWeek: ['APPROVED', 'PENDING'],
				reviewedTimesheetLogs: 0
			});
		});

		it('adds time to the pending timesheet a reviewed week already holds, without another one', () => {
			expect(measured[orm].byHandApprovedThenPending).toEqual({
				joined: 'existing not reviewed',
				status: 'PENDING',
				timesheetsOfWeek: ['APPROVED', 'PENDING'],
				reviewedTimesheetLogs: 0
			});
		});

		it('adds time to the week of a timesheet nobody reviewed as before', () => {
			expect(measured[orm].byHandPending).toEqual({
				joined: 'existing not reviewed',
				status: 'PENDING',
				timesheetsOfWeek: ['PENDING'],
				reviewedTimesheetLogs: 0
			});
		});
	});
});
