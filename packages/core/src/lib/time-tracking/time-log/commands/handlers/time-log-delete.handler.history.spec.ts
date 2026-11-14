// Must stay first: loads the entity graph before any handler pulls an entity (see activity.controller.spec.ts).
import '../../../../core/entities/internal';

import { ActionTypeEnum } from '@gauzy/contracts';
import { TimeLog } from '../../time-log.entity';
import { recordTimeLogHistory } from '../../time-log-history.writer';
import { TimeLogDeleteCommand } from '../time-log-delete.command';
import { TimeLogDeleteHandler } from './time-log-delete.handler';

// The history rows themselves have their own spec (time-log-history.writer.spec.ts).
jest.mock('../../time-log-history.writer', () => ({
	...jest.requireActual('../../time-log-history.writer'),
	recordTimeLogHistory: jest.fn(async () => undefined)
}));

/**
 * Entries a person deletes keep what they held in their history (ever-co/ever-gauzy#11922), written in the same
 * transaction as the deletion. A deletion the API makes on its own (the cut of an overlapped entry) records nothing.
 */
describe('TimeLogDeleteHandler: history of a deletion', () => {
	const entry = (id: string, taskId: string) =>
		new TimeLog({
			id,
			tenantId: 'tenant-1',
			organizationId: 'organization-1',
			employeeId: 'employee-paul',
			taskId,
			startedAt: new Date('2026-11-10T09:00:00.000Z'),
			stoppedAt: new Date('2026-11-10T11:00:00.000Z'),
			timeSlots: [],
			timesheetId: 'timesheet-1'
		});

	function setup() {
		const transactionRepository = { softDelete: jest.fn(async () => ({ affected: 2 })) };
		const transactionManager = { getRepository: jest.fn(() => transactionRepository) };
		const repository = {
			softDelete: jest.fn(async () => ({ affected: 2 })),
			manager: { transaction: jest.fn(async (work: (manager: unknown) => unknown) => work(transactionManager)) }
		};
		const commandBus = { execute: jest.fn(async () => undefined) };
		const handler = new TimeLogDeleteHandler(repository as never, {} as never, commandBus as never);
		const record = recordTimeLogHistory as jest.Mock;
		record.mockClear();
		return { handler, repository, transactionManager, transactionRepository, record };
	}

	beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
	afterEach(() => jest.restoreAllMocks());

	it('deletes the entries and records what each held, in one transaction', async () => {
		const { handler, repository, transactionManager, transactionRepository, record } = setup();

		await handler.execute(new TimeLogDeleteCommand([entry('log-1', 'task-login'), entry('log-2', 'task-signup')], false, {}));

		expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
		expect(repository.softDelete).not.toHaveBeenCalled();
		expect(transactionRepository.softDelete).toHaveBeenCalledTimes(1);
		const [manager, records] = record.mock.calls[0];
		expect(manager).toBe(transactionManager);
		expect(records.map((it) => it.subject.id)).toEqual(['log-1', 'log-2']);
		expect(records[0].change.action).toBe(ActionTypeEnum.Deleted);
		expect(records[0].change.previousValues).toContainEqual({ taskId: 'task-login' });
		expect(records[0].change.previousValues).toContainEqual({ stoppedAt: '2026-11-10T11:00:00.000Z' });
	});

	it('deletes alone, without a transaction or rows, when no history option is given', async () => {
		const { handler, repository, record } = setup();

		await handler.execute(new TimeLogDeleteCommand([entry('log-1', 'task-login')], false));

		expect(repository.manager.transaction).not.toHaveBeenCalled();
		expect(repository.softDelete).toHaveBeenCalledTimes(1);
		expect(record).not.toHaveBeenCalled();
	});
});
