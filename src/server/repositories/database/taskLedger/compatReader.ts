import 'server-only';

import { scheduleInForce } from '@/domain/taskRepeat';
import type { TaskStage } from '@/domain/taskStage';
import type { ClassTask, TaskAssignmentStatus } from '@/domain/types';
import type { TaskCurrentCycleStatusDto } from '@/domain/taskHistoryDtos';
import type { TaskReader } from '@/server/repositories/configuredTasks';
import { buildBankTaskProjection, type TaskCycleProjectionDto } from '@/server/taskReadProjection';
import { ensureTaskLedger, type RunTenantTransaction } from './migration';
import { readCurrentLedgerStates } from './currentState';
import {
  buildAdminTaskDto,
  clockNow,
  readLedgerFrom,
  readLedgerStudents,
  readLedgerTasks,
  sortTasks,
  type LedgerEventSource,
  type LedgerStudent,
  type LedgerTask,
} from './store';

/**
 * The earlier task read shape (ClassTask + "currentCycle"), produced from the stage ledger, for
 * the student bank and the remaining compatibility routes. There is no cycle: `currentCycle` is
 * simply "now" — every student's current stage — with the last/next automatic reset as its window.
 */
export function createTaskLedgerReader(dependencies: Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  runTenantSnapshot: RunTenantTransaction;
}>): TaskReader {
  const { tenantId } = dependencies;

  async function project(options: Readonly<{ taskId?: string; includeInactive?: boolean; studentId?: string; now?: string }>) {
    await ensureTaskLedger(dependencies);
    return dependencies.runTenantSnapshot(tenantId, async (tx) => {
      const ledgerFrom = await readLedgerFrom(tx, tenantId);
      // Stages are read at the database clock that ordered their events, whatever `now` the caller passes.
      const now = await clockNow(tx);
      const tasks = (await readLedgerTasks(tx, tenantId, options.taskId ? { taskIds: [options.taskId] } : {}))
        .filter((task) => options.includeInactive || task.isActive);
      const students = await readLedgerStudents(tx, tenantId);
      const events = ledgerFrom === null ? new Map() : await readCurrentLedgerStates(tx, tenantId, now, {
        taskInstanceIds: tasks.map((task) => task.taskInstanceId), ...(options.studentId ? { studentId: options.studentId } : {}) });
      const scoped = options.studentId ? students.filter((student) => student.studentId === options.studentId) : students;
      return { now, students, rows: sortTasks(tasks).map((task) => toProjection(task, scoped, events.get(task.taskInstanceId), now, options.studentId)) };
    });
  }

  return {
    async listTaskCycleProjections(options = {}) {
      return (await project(options)).rows;
    },
    async getTaskCycleProjection(taskId, options = {}) {
      return (await project({ ...options, taskId, includeInactive: true })).rows[0] ?? null;
    },
    async getTaskAssignmentStatus(taskId): Promise<TaskAssignmentStatus> {
      const { rows, students } = await project({ taskId, includeInactive: true });
      const row = rows[0];
      if (!row) throw new Error('과제를 찾을 수 없어요.');
      const names = new Map(students.map((student) => [student.studentId, student.name]));
      return {
        taskId,
        students: row.currentCycle.students.map((student) => ({
          studentId: student.studentId, name: names.get(student.studentId) ?? student.studentId,
          assigned: student.assigned, ready: student.ready ?? false, completed: student.completed, stage: student.stage,
          assignmentOrigin: 'EVENT', completionOrigin: 'EVENT',
        })),
      };
    },
    async getTaskHistoryDetail() {
      throw new Error('Task history of PostgreSQL classes is read from /api/task-ledger.');
    },
    async getBankTasks(now) {
      const { rows } = await project({ includeInactive: true, ...(now ? { now } : {}) });
      return buildBankTaskProjection(rows, now ?? new Date().toISOString());
    },
  };
}

function toProjection(task: LedgerTask, students: readonly LedgerStudent[],
  events: ReadonlyMap<string, LedgerEventSource> | undefined, now: string, studentId?: string): TaskCycleProjectionDto {
  const dto = buildAdminTaskDto(task, students, events, now);
  const inForce = scheduleInForce(task.currentSchedule, task.pendingSchedule, now);
  const byStage = (stage: TaskStage) => dto.students.filter((row) => row.stage === stage).map((row) => row.studentId);
  const currentCycle: TaskCurrentCycleStatusDto = {
    cycleId: 'ledger',
    startsAt: dto.repeat.lastResetAt ?? task.createdAt,
    endsAt: dto.repeat.nextResetAt,
    transition: 'PERMANENT',
    assignedStudentIds: dto.students.filter((row) => row.stage !== 'UNASSIGNED').map((row) => row.studentId),
    pendingStudentIds: byStage('PENDING'),
    readyStudentIds: byStage('READY'),
    completedStudentIds: byStage('COMPLETED'),
    students: dto.students.map((row) => ({
      studentId: row.studentId,
      assigned: row.stage !== 'UNASSIGNED',
      ready: row.stage === 'READY',
      completed: row.stage === 'COMPLETED',
      stage: row.stage,
      assignmentOrigin: 'EVENT',
      completionOrigin: 'EVENT',
    })),
  };
  const classTask: ClassTask = {
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    reward: task.reward,
    isActive: task.isActive,
    sortOrder: task.sortOrder,
    allowedStudentIds: currentCycle.assignedStudentIds,
    ...(task.availableFrom ? { availableFrom: task.availableFrom } : {}),
    ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...(task.prerequisiteTaskId ? { prerequisiteTaskId: task.prerequisiteTaskId } : {}),
    createdAt: task.createdAt,
    taskInstanceId: task.taskInstanceId,
    schedule: inForce,
    pendingSchedule: null,
  };
  const own = studentId ? dto.students.find((row) => row.studentId === studentId) : undefined;
  return {
    ...classTask,
    currentCycle,
    ...(studentId ? { studentStatus: {
      studentId,
      assigned: (own?.stage ?? 'UNASSIGNED') !== 'UNASSIGNED',
      ready: own?.stage === 'READY',
      completed: own?.stage === 'COMPLETED',
      stage: own?.stage ?? 'UNASSIGNED',
      assignmentOrigin: 'EVENT',
      completionOrigin: 'EVENT',
    } } : {}),
  };
}
