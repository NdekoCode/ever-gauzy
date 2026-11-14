// Must stay first: loads the entity graph before the service pulls an entity (see activity.controller.spec.ts).
import '../../core/entities/internal';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PermissionsEnum } from '@gauzy/contracts';
import { RequestContext } from '../../core/context';
import { TimeLogHistoryService } from './time-log-history.service';

/**
 * The history of time entries (ever-co/ever-gauzy#11922) is read under the time scoping: a member reads their own
 * entries' history, people who manage a member or may see everyone's time read theirs, nobody else.
 */
describe('TimeLogHistoryService scoping', () => {
	function setup(options: { entry?: { employeeId: string } | null; rows?: unknown[]; manages?: boolean } = {}) {
		const manager = {
			findOne: jest.fn(async (_entity: unknown, _options?: unknown) => options.entry ?? null),
			find: jest.fn(async (_entity: unknown, _options?: unknown) => options.rows ?? []),
			createQueryBuilder: jest.fn()
		};
		const timeLogService = {
			assertCanReadEmployeeTimeLogs: jest.fn(async (employeeId: string) => {
				if (employeeId !== 'employee-paul') {
					throw new ForbiddenException('You do not have permission to read time logs for this employee');
				}
			})
		};
		const managedEmployeeService = { canManageEmployees: jest.fn(async () => options.manages ?? false) };
		const service = new TimeLogHistoryService(
			{ manager } as never,
			timeLogService as never,
			managedEmployeeService as never
		);
		return { service, manager, timeLogService, managedEmployeeService };
	}

	const signedInAs = (employeeId: string | null, permissions: PermissionsEnum[] = []) => {
		jest.spyOn(RequestContext, 'currentTenantId').mockReturnValue('tenant-1');
		jest.spyOn(RequestContext, 'currentEmployeeId').mockReturnValue(employeeId);
		jest.spyOn(RequestContext, 'currentUser').mockReturnValue({ employeeId } as never);
		jest.spyOn(RequestContext, 'hasPermission').mockImplementation((permission: PermissionsEnum) =>
			permissions.includes(permission)
		);
	};

	afterEach(() => jest.restoreAllMocks());

	describe('readableEmployeeIds', () => {
		it('lets a caller who may see everyone read every member, or the members named', async () => {
			signedInAs(null, [PermissionsEnum.CHANGE_SELECTED_EMPLOYEE]);
			const { service } = setup();

			expect(await service.readableEmployeeIds(undefined)).toBeUndefined();
			expect(await service.readableEmployeeIds(['employee-marie'])).toEqual(['employee-marie']);
		});

		it("keeps a member to their own entries, even when they name another member's", async () => {
			signedInAs('employee-paul');
			const { service } = setup({ manages: false });

			expect(await service.readableEmployeeIds(undefined)).toEqual(['employee-paul']);
			expect(await service.readableEmployeeIds(['employee-marie'])).toEqual(['employee-paul']);
		});

		it('lets a team manager read the members they manage', async () => {
			signedInAs('employee-manager');
			const { service, managedEmployeeService } = setup({ manages: true });

			expect(await service.readableEmployeeIds(['employee-paul', 'employee-manager'])).toEqual([
				'employee-paul',
				'employee-manager'
			]);
			expect(managedEmployeeService.canManageEmployees).toHaveBeenCalledWith(['employee-paul'], []);
		});

		it('reads nobody for a caller without an employee record who may not see everyone', async () => {
			signedInAs(null);
			const { service } = setup();

			expect(await service.readableEmployeeIds(['employee-paul'])).toEqual([]);
		});
	});

	describe('findEntryHistory', () => {
		it("answers the entry's rows, newest first, to a caller who may read its owner's time", async () => {
			signedInAs('employee-paul');
			const rows = [{ id: 'row-2' }, { id: 'row-1' }];
			const { service, manager, timeLogService } = setup({ entry: { employeeId: 'employee-paul' }, rows });

			expect(await service.findEntryHistory('log-1')).toBe(rows);
			expect(timeLogService.assertCanReadEmployeeTimeLogs).toHaveBeenCalledWith('employee-paul');
			expect(manager.find.mock.calls[0][1]).toMatchObject({
				where: { entity: 'TimeLog', entityId: 'log-1', tenantId: 'tenant-1' },
				order: { createdAt: 'DESC' }
			});
			expect(manager.findOne.mock.calls[0][1]).toMatchObject({ withDeleted: true });
		});

		it('refuses the history of another member to a caller who may not read their time', async () => {
			signedInAs('employee-amina');
			const { service } = setup({ entry: { employeeId: 'employee-marie' }, rows: [{ id: 'row-1' }] });

			await expect(service.findEntryHistory('log-1')).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('knows a hard-deleted entry by the owner its rows keep', async () => {
			signedInAs('employee-paul');
			const rows = [{ id: 'row-1', data: { employeeId: 'employee-paul' } }];
			const { service, timeLogService } = setup({ entry: null, rows });

			expect(await service.findEntryHistory('log-1')).toBe(rows);
			expect(timeLogService.assertCanReadEmployeeTimeLogs).toHaveBeenCalledWith('employee-paul');
		});

		it('answers 404 for an entry the tenant never had', async () => {
			signedInAs('employee-paul');
			const { service } = setup({ entry: null, rows: [] });

			await expect(service.findEntryHistory('log-1')).rejects.toBeInstanceOf(NotFoundException);
		});
	});

	describe('findPeriodHistory', () => {
		it('answers an empty page, without querying, to a caller who reads nobody', async () => {
			signedInAs(null);
			const { service, manager } = setup();

			const page = await service.findPeriodHistory({
				organizationId: 'org-1',
				startDate: new Date('2026-11-01'),
				endDate: new Date('2026-11-30')
			} as never);

			expect(page).toEqual({ items: [], total: 0 });
			expect(manager.createQueryBuilder).not.toHaveBeenCalled();
		});
	});
});
